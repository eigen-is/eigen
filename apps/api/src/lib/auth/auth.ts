// The better-auth instance: password sign-in and sessions, two-factor codes, app passwords, admin actions and the
// organization with its teams, on the server-wide users database. Its hooks keep Eigen in step, for example joining
// a new account to the default org or tearing down a deleted user's data. The file also holds the helpers that reach
// that database directly, such as Eigen's own Drizzle handle on it and the copy a backup takes.

import { Database } from 'bun:sqlite';
import { apiKey } from '@better-auth/api-key';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import { defaultAc, userAc } from 'better-auth/plugins/admin/access';
import { and, eq, notInArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as authSchema from '../../../auth-schema';
import { isProduction, isTest } from '../config/env';
import { getServerDataPath, SERVER_DATABASES } from '../config/paths';
import {
    getAuthSecret,
    getDomain,
    getOrgName,
    getServedOrigin,
    getServerConfig,
    isRoleAddress,
} from '../config/server-config';
import { ApiError } from '../core';
import { composeOtpEmail } from '../mailer/mail-composers';
import { sendMail } from '../mailer/mailer';
import { reconcileSharesForNewTeamMember, reconcileSharesForNewUser } from '../share';
import { getTeamExists } from '../team';
import { getOrgRole, getUserById, isGuest } from '../user';
import { ensureAuthSchemaColumns } from './auth-schema-columns';

// The columns better-auth needs are added before it first reads the database.
{
    const db = new Database(getServerDataPath(SERVER_DATABASES.users));
    ensureAuthSchemaColumns(db);
    db.close();
}

// Every app password is this many ASCII letters, from the plugin's generator with no prefix. So protocol auth can
// tell one from an account password without a key lookup.
export const APP_PASSWORD_LENGTH = 64;

// A dev checkout serves each app on its own port, from 3000 to 3014.
const DEV_ORIGINS = [
    'http://localhost',
    'https://localhost',
    ...Array.from({ length: 15 }, (_, index) => `http://localhost:${3000 + index}`),
];

// better-auth's admin role without the ban, which would leave a user's app passwords working, and without the
// impersonation and password set that disabledPaths closes.
const eigenAdminRole = defaultAc.newRole({
    user: ['create', 'list', 'set-role', 'delete', 'set-email', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
});

export const auth = betterAuth({
    database: drizzleAdapter(drizzle(getServerDataPath(SERVER_DATABASES.users)), {
        provider: 'sqlite',
        schema: authSchema,
    }),
    databaseHooks: {
        session: {
            create: {
                after: async (session) => {
                    // A session is created at sign-in and only updated when it refreshes, so this is the last
                    // sign-in, not the last activity.
                    await getAuthDrizzleDb()
                        .update(authSchema.user)
                        .set({ lastLoginAt: new Date() })
                        .where(eq(authSchema.user.id, session.userId));
                    // Sign-up's join only logs on failure, so sign-in is the repair path for it.
                    try {
                        await ensureDefaultOrgMembership(session.userId);
                    } catch (error) {
                        console.warn(`Failed to auto-join user ${session.userId} to default org on sign-in:`, error);
                    }
                },
            },
        },
        user: {
            create: {
                before: async (user) => {
                    rejectRoleAddress(user.email);
                },
                after: async (created) => {
                    // better-auth's hook hands over the user without the plugin fields, such as the role.
                    const user = await getUserById(created.id);
                    if (!user || isGuest(user)) return;
                    // The row is committed, so a failure here must not turn a created account into a 500. Each
                    // step has its own guard, so a failed org join still reconciles.
                    try {
                        await ensureDefaultOrgMembership(user.id);
                    } catch (error) {
                        console.error(`Failed to auto-join new user ${user.id} to default org:`, error);
                    }
                    try {
                        await reconcileSharesForNewUser(user);
                    } catch (error) {
                        console.error(`Failed to reconcile shares for new user ${user.id}:`, error);
                    }
                },
            },
            update: {
                // An update that only changes the name or the image has no email.
                before: async (user) => {
                    rejectRoleAddress(user.email);
                },
            },
            delete: {
                // Every better-auth deletion passes here while the user row still exists, so Eigen's whole
                // teardown runs here. A member row left behind would break listMembers for the whole org. The
                // import is lazy because delete-user imports this file directly, so a static import would be a cycle.
                before: async (deleted) => {
                    const user = await getUserById(deleted.id);
                    if (!user) return;
                    const { teardownUserData } = await import('../user/delete-user');
                    await busyHomeAsConflict(() => teardownUserData(user));
                },
                // The row is gone, so its home may open again: a restore can bring the user back under the same id.
                after: async (user) => {
                    const { clearHomeDeleting } = await import('../home/get-home');
                    clearHomeDeleting(user.id);
                },
            },
        },
    },
    hooks: {
        // Every org admin also holds user.role 'admin', which lets the admin plugin act on the owner past requireOwner.
        before: createAuthMiddleware(async (ctx) => {
            const targetId = ctx.body?.userId;
            if (!ctx.path.startsWith('/admin/') || typeof targetId !== 'string') return;
            // No session is the plugin's 401, before any lookup that would tell the owner's id apart.
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if ((await getOrgRole(targetId)) === 'owner' && session.user.id !== targetId) {
                throw new APIError('FORBIDDEN', { message: "Only the owner can change the owner's account" });
            }
            // A guest's account belongs to the emailed-code sign-in, and nothing turns a guest into a user.
            if (
                (ctx.path === '/admin/set-role' || ctx.path === '/admin/update-user') &&
                isGuest(await getUserById(targetId))
            ) {
                throw new APIError('FORBIDDEN', { message: "A guest's account can't be changed" });
            }
            // remove-user drops the sessions and the password before user.delete.before can refuse, with no rollback.
            // Admins only: anyone else gets the plugin's 403, not word of a running job.
            if (ctx.path === '/admin/remove-user' && session.user['role'] === 'admin') {
                const { requireHomeSlotFree } = await import('../backup/jobs');
                await busyHomeAsConflict(() => requireHomeSlotFree(targetId));
            }
        }),
    },
    emailAndPassword: {
        enabled: true,
        minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    advanced: {
        // The same order as clientIpKey, X-Real-IP first. better-auth reads the headers itself, so the order is
        // declared here. Caddy overwrites both on proxied routes, so a client cannot fake them.
        ipAddress: { ipAddressHeaders: ['x-real-ip', 'x-forwarded-for'] },
    },
    rateLimit: {
        // Eigen sets PRODUCTION=1, not NODE_ENV, so better-auth would never turn this on by itself. The general
        // limit stays loose, because the server's own limiter handles broad abuse and a low one would throttle
        // get-session for an office behind one address. The credential endpoints get a hard limit.
        enabled: true,
        window: 60,
        max: 1000,
        customRules: {
            '/sign-in/email': { window: 60, max: 10 },
            '/two-factor/*': { window: 60, max: 10 },
        },
    },
    plugins: [
        twoFactor({
            issuer: 'eigen',
            otpOptions: {
                async sendOTP({ user, otp }) {
                    const ok = await sendMail(
                        composeOtpEmail({ name: user.name, email: user.email }, otp, '2fa', getOrgName(), getDomain()),
                    );
                    if (!ok) throw new ApiError(500, 'Failed to send verification code');
                },
            },
        }),
        // Only these two roles may be set. A guest's role is written by the guest sign-in alone.
        admin({ roles: { admin: eigenAdminRole, user: userAc } }),
        // Eigen uses the organization plugin for its data model only, the members, teams and roles, and not for
        // its invitations, so no sendInvitationEmail is wired. People arrive through the waitlist or an admin. The
        // user-create hook joins them to the default org and team, and the admin UI adds them to other teams.
        organization({
            // Eigen has one org. A user who could create another would own it and get past requireAdmin.
            // Setup creates the default org as a server call without a session, which this does not block.
            allowUserToCreateOrganization: false,
            // Default caps the org at 100 members and fails every later user creation in the create hook.
            // The function form lifts the cap without turning the plugin's list-query limit into Infinity.
            membershipLimit: () => Number.POSITIVE_INFINITY,
            teams: {
                enabled: true,
            },
            organizationHooks: {
                afterAddTeamMember: async ({ teamMember }) => {
                    await reconcileSharesForNewTeamMember(teamMember.userId, teamMember.teamId);
                },
                // The team row still exists here, and a throw keeps it, as user.delete.before does for a user.
                // The default team holds the org-wide drive every member joins, and its teardown can't be undone.
                beforeDeleteTeam: async ({ team }) => {
                    if (team.id === getServerConfig()?.defaultTeamId) {
                        throw new APIError('FORBIDDEN', {
                            message: "The organization's default team can't be deleted",
                        });
                    }
                    const { teardownTeamData } = await import('../team/delete-team');
                    await busyHomeAsConflict(() => teardownTeamData(team.id));
                },
                afterDeleteTeam: async ({ team }) => {
                    // Lazy imports to avoid the static cycle (home-relay → get-home → team → auth).
                    const { clearHomeDeleting } = await import('../home/get-home');
                    clearHomeDeleting(teamOwnerId(team.id));
                    const { pushTeamAvatar } = await import('../home/home-relay');
                    await pushTeamAvatar(team.id, null);
                },
            },
        }),
        apiKey({
            defaultKeyLength: APP_PASSWORD_LENGTH,
            rateLimit: { enabled: false },
        }),
    ],
    trustedOrigins: getTrustedOrigins(),
    appName: 'eigen',
    baseURL: process.env['API_URL'],
    basePath: '/auth',
    // set-user-password revokes no sessions or app passwords, so admins reset through PUT
    // /settings/user/:userId/password instead. Impersonation would hand an admin any member's session. Eigen
    // offers no bans: a ban ends the browser sessions, but the app passwords would keep working.
    disabledPaths: ['/admin/set-user-password', '/admin/impersonate-user', '/admin/ban-user', '/admin/unban-user'],
    logger: { disabled: isTest() },
    secret: getAuthSecret(),
});

// The origins better-auth and CORS accept: the served origin, and the dev origins only outside production.
export function getTrustedOrigins(): string[] {
    const served = getServedOrigin();
    return isProduction() ? [served] : [served, ...DEV_ORIGINS];
}

// A Drizzle handle of our own beside better-auth's. better-auth runs the lifecycle of the one it gets through
// drizzleAdapter, so that one is not shared.
let authDrizzleDb: ReturnType<typeof drizzle> | undefined;

export function getAuthDrizzleDb(): ReturnType<typeof drizzle> {
    if (!authDrizzleDb) {
        authDrizzleDb = drizzle(getServerDataPath(SERVER_DATABASES.users), {
            schema: authSchema,
        });
    }
    return authDrizzleDb;
}

// Deletes the auth rows that point at a user and that better-auth leaves, such as memberships, 2FA and app
// passwords. The memberships of users who are already gone go too, so a server that collected such rows from older
// raw better-auth deletions heals at its next delete.
export function authDeleteUserReferences(userId: string): void {
    const db = getAuthDrizzleDb();
    const userIds = db.select({ id: authSchema.user.id }).from(authSchema.user);
    db.delete(authSchema.member)
        .where(or(eq(authSchema.member.userId, userId), notInArray(authSchema.member.userId, userIds)))
        .run();
    db.delete(authSchema.teamMember)
        .where(or(eq(authSchema.teamMember.userId, userId), notInArray(authSchema.teamMember.userId, userIds)))
        .run();
    db.delete(authSchema.twoFactor).where(eq(authSchema.twoFactor.userId, userId)).run();
    db.delete(authSchema.apikey).where(eq(authSchema.apikey.referenceId, userId)).run();
}

// The server backup's copy, through the handle the server writes with.
export function stageAuthDbCopy(destPath: string): void {
    getAuthDrizzleDb().$client.run('VACUUM INTO ?', [destPath]);
}

// Nobody may claim an RFC 2142 role address, such as postmaster, on this server's mail domain. Guests on
// external addresses are not affected.
function rejectRoleAddress(email: string | undefined): void {
    if (email && isRoleAddress(email)) {
        throw new APIError('BAD_REQUEST', { message: 'This address is reserved' });
    }
}

// better-auth answers any error but its own APIError with a 500. A busy home's 409 is rethrown as its CONFLICT.
async function busyHomeAsConflict(run: () => unknown): Promise<void> {
    try {
        await run();
    } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
            throw new APIError('CONFLICT', { message: error.message });
        }
        throw error;
    }
}

// Joins the default org that setup pinned in the config, and its default team. The sign-up hook and every sign-in
// call it, so an account whose join failed at sign-up gets in at its next sign-in instead of staying outside the org.
async function ensureDefaultOrgMembership(userId: string): Promise<void> {
    const config = getServerConfig();
    if (!config) return;
    const { orgId, defaultTeamId } = config;

    const db = getAuthDrizzleDb();
    const membership = await db
        .select({ id: authSchema.member.id })
        .from(authSchema.member)
        .where(and(eq(authSchema.member.userId, userId), eq(authSchema.member.organizationId, orgId)))
        .get();
    if (membership) return;

    // Guests hold accounts and sign in, but never join the org.
    if (isGuest(await getUserById(userId))) return;

    // addMember refuses a team that is gone, org join included, so a deleted default team must not reach it.
    const teamId = defaultTeamId && (await getTeamExists(defaultTeamId)) ? defaultTeamId : undefined;
    await auth.api.addMember({
        body: {
            userId,
            organizationId: orgId,
            role: 'member',
            teamId,
        },
    });
    if (!teamId) return;
    // addMember skips afterAddTeamMember.
    try {
        await reconcileSharesForNewTeamMember(userId, teamId);
    } catch (error) {
        console.error(`Failed to reconcile default team shares for user ${userId}:`, error);
    }
}
