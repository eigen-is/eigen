import type { AdminUser, AdminUserRow } from '@workspace/lib/types/admin';
import type { S3Config } from '@workspace/lib/types/mount';
import type { HomeSizeResponse, S3CheckResult, S3HardenResult, ServerSettings } from '@workspace/lib/types/settings';
import { validateEmailAddress } from '@workspace/lib/validation';
import { eq, isNull, ne, or, sql } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { member, session, team, teamMember, user } from '../../auth-schema';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { getOrgName, getServerConfig, updateServerConfig } from '../lib/config/server-config';
import { getS3Config, getServerSettings, updateServerSettings } from '../lib/config/server-settings';
import { type ControlStatus, getServerStatus } from '../lib/config/server-status';
import { ApiError } from '../lib/core';
import { requireAdmin, requireOwner } from '../lib/core/access';
import { buildMailOptions, createTransport } from '../lib/core/mailer';
import { checkS3Connection, hardenS3Bucket } from '../lib/storage/s3-storage';
import { getOrgRole, getUserById } from '../lib/user';
import { getAllUsersUsage } from '../lib/user/admin-usage';
import { deleteUserCompletely } from '../lib/user/delete-user';
import { resetUserPassword } from '../lib/user/reset-password';
import { betterAuth } from './auth';
import { s3ConfigBody, s3HardenBody, senderAddressSchema, senderNameSchema, toS3Config } from './shared-schemas';

// Who appears on the admin Users page: everyone except guests, orphans included.
// `ne(user.role, 'guest')` alone excludes NULL-role orphans in SQLite, so OR in isNull.
const nonGuestUsers = () => or(isNull(user.role), ne(user.role, 'guest'));

export const settingsRouter = new Elysia({ name: 'settings' })
    .use(betterAuth)

    .get(
        '/settings/server',
        async ({ user }): Promise<ServerSettings> => {
            await requireAdmin(user.id);
            const settings = getServerSettings();
            const { s3Config } = settings.defaults.mount;
            // The secret is the owner's, as on /settings/s3config; an admin's team mount form takes the rest.
            if (!s3Config || (await getOrgRole(user.id)) === 'owner') return settings;
            const mount = { ...settings.defaults.mount, s3Config: { ...s3Config, secretAccessKey: '' } };
            return { ...settings, defaults: { mount } };
        },
        { auth: true },
    )

    .put(
        '/settings/server',
        async ({ body, user }): Promise<ServerSettings> => {
            await requireOwner(user.id);
            if (body.defaults?.mount?.storageType === 's3') {
                const s3 = getS3Config();
                if (!s3) throw new ApiError(400, 'Cannot set storage type to S3 without a saved S3 configuration');
                const s3Result = await checkS3Connection(s3);
                if (!s3Result.ok) throw new ApiError(400, `Cannot set storage type to S3: ${s3Result.message}`);
            }
            const senderAddress = body.mail?.senderAddress;
            if (senderAddress && !validateEmailAddress(senderAddress)) {
                throw new ApiError(400, `${senderAddress} is not a valid sender address`);
            }
            if (body.mail?.senderName) body.mail.senderName = body.mail.senderName.trim();
            await updateServerSettings(body);
            return getServerSettings();
        },
        {
            body: t.Object({
                quotas: t.Optional(
                    t.Object({
                        mailAndContactsMaxMB: t.Optional(t.Number({ minimum: 10 })),
                        defaultMountMaxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                        maxUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
                        trashRetentionDays: t.Optional(t.Number({ minimum: 1 })),
                    }),
                ),
                defaults: t.Optional(
                    t.Object({
                        mount: t.Optional(
                            t.Object({
                                storageType: t.Optional(
                                    t.Union([t.Literal('local-id'), t.Literal('local-fullnames'), t.Literal('s3')]),
                                ),
                            }),
                        ),
                    }),
                ),
                onboarding: t.Optional(
                    t.Object({
                        waitlist: t.Optional(
                            t.Object({
                                enabled: t.Optional(t.Boolean()),
                            }),
                        ),
                        autoAddOwnerContact: t.Optional(t.Boolean()),
                        welcomeMail: t.Optional(
                            t.Object({
                                enabled: t.Optional(t.Boolean()),
                                subject: t.Optional(t.String()),
                                body: t.Optional(t.String()),
                            }),
                        ),
                        inviteEmail: t.Optional(
                            t.Object({
                                subject: t.Optional(t.String()),
                                body: t.Optional(t.String()),
                            }),
                        ),
                    }),
                ),
                guests: t.Optional(
                    t.Object({
                        openSignup: t.Optional(t.Boolean()),
                        inactivityDays: t.Optional(t.Number({ minimum: 1, maximum: 365 })),
                    }),
                ),
                landing: t.Optional(
                    t.Object({
                        links: t.Optional(
                            t.Array(
                                t.Object({
                                    title: t.String({ minLength: 1, maxLength: 80 }),
                                    url: t.String({ minLength: 1, maxLength: 2048, pattern: '^https?://' }),
                                }),
                                { maxItems: 20 },
                            ),
                        ),
                    }),
                ),
                notifications: t.Optional(
                    t.Object({
                        email: t.Optional(
                            t.Object({
                                guestOnAclAdd: t.Optional(t.Boolean()),
                                userOnAclAdd: t.Optional(t.Boolean()),
                                userOnCalendarInvite: t.Optional(t.Boolean()),
                                ownerOnAccessRequest: t.Optional(t.Boolean()),
                            }),
                        ),
                    }),
                ),
                mail: t.Optional(
                    t.Object({
                        senderName: t.Optional(senderNameSchema),
                        senderAddress: t.Optional(senderAddressSchema),
                        relaySendsAsUsers: t.Optional(t.Boolean()),
                    }),
                ),
            }),
            auth: true,
        },
    )

    .get(
        '/settings/s3config',
        async ({ user }): Promise<S3Config | null> => {
            await requireOwner(user.id);
            return getS3Config() ?? null;
        },
        { auth: true },
    )

    .put(
        '/settings/s3config',
        async ({ body, user }): Promise<S3Config | null> => {
            await requireOwner(user.id);
            const s3Config = toS3Config(body);
            const s3Result = await checkS3Connection(s3Config);
            if (!s3Result.ok) throw new ApiError(400, `S3 connection failed: ${s3Result.message}`);
            await updateServerSettings({ defaults: { mount: { s3Config } } });
            return getS3Config() ?? null;
        },
        { body: s3ConfigBody, auth: true },
    )

    .get(
        '/settings/status',
        async ({ user }): Promise<ControlStatus> => {
            await requireOwner(user.id);
            return getServerStatus();
        },
        { auth: true },
    )

    // The web address and the mail domain stay as setup made them: every account is on them.
    .put(
        '/settings/organization',
        async ({ body, user, request }): Promise<{ name: string }> => {
            await requireOwner(user.id);
            const name = body.name.trim();
            if (!name) throw new ApiError(400, 'The organization needs a name');
            await auth.api.updateOrganization({
                body: { organizationId: getServerConfig()?.orgId, data: { name } },
                headers: request.headers,
            });
            await updateServerConfig({ orgName: name });
            return { name: getOrgName() };
        },
        { body: t.Object({ name: t.String({ minLength: 1, maxLength: 100 }) }), auth: true },
    )

    // sendMail swallows a failure; this one hands the relay's answer back to the owner. From the owner, as a
    // share notification is, so it tests whether the relay sends as users.
    .post(
        '/settings/mail/test',
        async ({ user }): Promise<{ to: string }> => {
            await requireOwner(user.id);
            const orgName = getOrgName();
            try {
                await createTransport().sendMail(
                    buildMailOptions({
                        from: { name: user.name, address: user.email },
                        to: [{ name: user.name, address: user.email }],
                        subject: `Test mail from ${orgName}`,
                        text: `This is a test mail from ${orgName}. It arrived, so this server can send mail.`,
                    }),
                );
            } catch (error) {
                throw new ApiError(
                    502,
                    `The test mail was not sent: ${error instanceof Error ? error.message : error}`,
                );
            }
            return { to: user.email };
        },
        { auth: true },
    )

    .get(
        '/settings/users',
        async ({ user: authUser }): Promise<AdminUserRow[]> => {
            await requireAdmin(authUser.id);
            const db = getAuthDrizzleDb();
            const orgId = getServerConfig()?.orgId;
            // Project explicitly so the wire payload matches AdminUserRow exactly — `select()`
            // would ship banReason / twoFactorEnabled / banned etc. to the admin UI.
            const users = db
                .select({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    createdAt: user.createdAt,
                    lastLoginAt: user.lastLoginAt,
                })
                .from(user)
                .where(nonGuestUsers())
                .all();
            const members = orgId
                ? db
                      .select({ id: member.id, userId: member.userId, role: member.role })
                      .from(member)
                      .where(eq(member.organizationId, orgId))
                      .all()
                : [];
            // Scope to the configured org like the member query above — teams belong to an org, so
            // an unscoped join would leak other orgs' team memberships into this org's admin view.
            const teamRows = orgId
                ? db
                      .select({ userId: teamMember.userId, name: team.name })
                      .from(teamMember)
                      .innerJoin(team, eq(teamMember.teamId, team.id))
                      .where(eq(team.organizationId, orgId))
                      .all()
                : [];
            // MAX() over a timestamp-mode column comes back as raw epoch seconds
            const lastSessions = db
                .select({ userId: session.userId, last: sql<number>`max(${session.updatedAt})` })
                .from(session)
                .groupBy(session.userId)
                .all();
            const memberByUser = new Map(members.map((m) => [m.userId, m]));
            const sessionByUser = new Map(lastSessions.map((s) => [s.userId, new Date(s.last * 1000)]));
            const teamsByUser = new Map<string, string[]>();
            for (const t of teamRows) {
                const names = teamsByUser.get(t.userId);
                if (names) names.push(t.name);
                else teamsByUser.set(t.userId, [t.name]);
            }
            return users.map((u) => {
                const m = memberByUser.get(u.id);
                const seen = [u.lastLoginAt, sessionByUser.get(u.id)].filter((d): d is Date => d != null);
                const lastActiveAt = seen.length ? new Date(Math.max(...seen.map(Number))) : null;
                return {
                    id: u.id,
                    name: u.name,
                    email: u.email,
                    memberId: m?.id ?? null,
                    role: (m?.role as AdminUserRow['role']) ?? null,
                    createdAt: u.createdAt,
                    lastActiveAt,
                    teams: teamsByUser.get(u.id) ?? [],
                };
            });
        },
        { auth: true },
    )

    .get(
        '/settings/users/guests',
        async ({ user: authUser }): Promise<AdminUser[]> => {
            await requireAdmin(authUser.id);
            const db = getAuthDrizzleDb();
            // Project explicitly so the wire payload matches AdminUser exactly — `select()`
            // would ship banReason / twoFactorEnabled / banned etc. to the admin UI.
            return db
                .select({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    createdAt: user.createdAt,
                })
                .from(user)
                .where(eq(user.role, 'guest'))
                .all();
        },
        { auth: true },
    )

    .get(
        '/settings/users/usage',
        async ({ user: authUser }): Promise<Record<string, HomeSizeResponse>> => {
            await requireAdmin(authUser.id);
            const db = getAuthDrizzleDb();
            const ids = db.select({ id: user.id }).from(user).where(nonGuestUsers()).all();
            return getAllUsersUsage(ids.map((r) => r.id));
        },
        { auth: true },
    )

    .delete(
        '/settings/user/:userId',
        async ({ params, user, request }) => {
            await requireAdmin(user.id);
            if (params.userId === user.id) {
                throw new ApiError(400, 'Cannot delete your own account');
            }
            if ((await getOrgRole(params.userId)) === 'owner') {
                throw new ApiError(400, 'The server owner cannot be deleted');
            }
            await deleteUserCompletely(params.userId, request.headers);
            return { success: true };
        },
        { auth: true },
    )

    .put(
        '/settings/user/:userId/password',
        async ({ params, body, user }): Promise<{ success: boolean }> => {
            await requireAdmin(user.id);
            const target = await getUserById(params.userId);
            if (!target) throw new ApiError(404, 'User not found');
            if (target.id !== user.id && (await getOrgRole(target.id)) === 'owner') {
                throw new ApiError(403, "Only the owner can change the owner's password");
            }
            await resetUserPassword(target.email, body.password);
            return { success: true };
        },
        { body: t.Object({ password: t.String() }), auth: true },
    )

    .post(
        '/settings/s3check',
        async ({ body, user }): Promise<S3CheckResult> => {
            await requireAdmin(user.id);
            return checkS3Connection(toS3Config(body));
        },
        { body: s3ConfigBody, auth: true },
    )

    .post(
        '/settings/s3harden',
        async ({ body, user }): Promise<S3HardenResult> => {
            await requireAdmin(user.id);
            return hardenS3Bucket(toS3Config(body), body.noncurrentDays);
        },
        { body: s3HardenBody, auth: true },
    );
