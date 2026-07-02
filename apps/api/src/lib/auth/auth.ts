import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import {
    account as accountScheme,
    apikey as apikeyScheme,
    invitation as invitationScheme,
    member as memberScheme,
    organization as organizationScheme,
    session as sessionScheme,
    teamMember as teamMemberScheme,
    team as teamScheme,
    twoFactor as twoFactorScheme,
    user as userScheme,
    verification as verificationScheme,
} from '../../../auth-schema.ts';
import { isTest } from '../config/env';
import { getServerDataPath } from '../config/paths';
import { getDomain, getOrgName, getServerConfig } from '../config/server-config';
import { ApiError } from '../core';
import { composeOtpEmail } from '../core/mail-composers';
import { sendMail } from '../core/mailer';
import { reconcileSharesForNewTeamMember, reconcileSharesForNewUser } from '../share';
import type { User } from '../user';

const deploymentDomain = getDomain();
export const trustedOrigins = [
    'http://localhost',
    'https://localhost',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'http://localhost:3004',
    'http://localhost:3005',
    'http://localhost:3006',
    'http://localhost:3007',
    'http://localhost:3008',
    'http://localhost:3009',
    'http://localhost:3010',
    'http://localhost:3011',
    'http://localhost:3012',
    'http://localhost:3013',
    ...(deploymentDomain !== 'localhost' ? [`https://${deploymentDomain}`] : []),
];

export const auth = betterAuth({
    database: drizzleAdapter(drizzle(getServerDataPath('users3.db')), {
        provider: 'sqlite',
        schema: {
            user: userScheme,
            session: sessionScheme,
            account: accountScheme,
            verification: verificationScheme,
            twoFactor: twoFactorScheme,
            organization: organizationScheme,
            member: memberScheme,
            invitation: invitationScheme,
            team: teamScheme,
            teamMember: teamMemberScheme,
            apikey: apikeyScheme,
        },
    }),
    databaseHooks: {
        user: {
            create: {
                after: async (hookUser) => {
                    // better-auth's hook type omits admin/twoFactor plugin fields,
                    // but the runtime row has them. Cast to our User type at the
                    // boundary so the rest of the app doesn't need to thread the
                    // looser shape through.
                    const user = hookUser as User;
                    if (user.role === 'guest') return;
                    await authAddUserToDefaultOrg(user);
                    await reconcileSharesForNewUser(user);
                },
            },
        },
    },
    emailAndPassword: {
        enabled: true,
    },
    advanced: {
        // Same X-Real-IP → X-Forwarded-For precedence as clientIpKey (lib/core/access); better-auth
        // extracts the IP itself from these header names, so it declares the precedence here rather
        // than calling the helper. Caddy overwrites both on proxied routes, so they're not spoofable.
        ipAddress: { ipAddressHeaders: ['x-real-ip', 'x-forwarded-for'] },
    },
    rateLimit: {
        // Eigen sets PRODUCTION=1, not NODE_ENV, so better-auth's prod auto-enable never fires.
        // Force it on; keep the general window loose (the global limiter handles broad abuse, and
        // a low default would throttle high-frequency get-session for NAT'd offices) and throttle
        // the credential endpoints hard.
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
        admin(),
        // We use the organization plugin only for its data model (members, teams, RBAC) —
        // not its invitation flow. New external users are onboarded via the waitlist
        // (see apps/api/src/lib/waitlist), which is why no `sendInvitationEmail` hook is wired
        // here. Existing users get auto-added to the default org via the user-create hook
        // above, and to teams via `auth.api.addMember` (admin UI), which both bypass invites.
        organization({
            teams: {
                enabled: true,
            },
            organizationHooks: {
                afterAddTeamMember: async ({ teamMember }) => {
                    await reconcileSharesForNewTeamMember(teamMember.userId, teamMember.teamId);
                },
            },
        }),
        apiKey({
            rateLimit: { enabled: false },
        }),
    ],
    trustedOrigins,
    appName: 'eigen',
    baseURL: process.env['API_URL'],
    basePath: '/auth',
    logger: { disabled: isTest() },
    // Falls back to random UUID before setup is completed — intentional since sessions don't
    // need to persist across restarts during the pre-setup phase.
    secret: getServerConfig()?.secret || crypto.randomUUID(),
});

export async function authAddUserToDefaultOrg(user: User): Promise<void> {
    const db = getAuthDrizzleDb();
    const org = await db.select().from(organizationScheme).get();

    if (!org) return;

    try {
        await auth.api.addMember({
            body: {
                userId: user.id,
                organizationId: org.id,
                role: 'member',
            },
        });
    } catch (error) {
        throw new ApiError(
            500,
            `Failed to auto-join user ${user.id} to default org: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// Separate Drizzle instance from better-auth's internal one — better-auth controls its own
// connection lifecycle, so we can't safely share the instance it creates via drizzleAdapter().
let authDrizzleDb: ReturnType<typeof drizzle> | undefined;

export function getAuthDrizzleDb() {
    if (!authDrizzleDb) {
        authDrizzleDb = drizzle(getServerDataPath('users3.db'), {
            schema: {
                user: userScheme,
                session: sessionScheme,
                account: accountScheme,
                verification: verificationScheme,
                twoFactor: twoFactorScheme,
                organization: organizationScheme,
                member: memberScheme,
                invitation: invitationScheme,
                team: teamScheme,
                teamMember: teamMemberScheme,
                apikey: apikeyScheme,
            },
        });
    }
    return authDrizzleDb;
}
