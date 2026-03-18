import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {getServerDataPath} from "../config/paths";
import {getServerConfig} from "../config/server-config";
import {admin, organization, twoFactor} from "better-auth/plugins"
import {
    account as accountScheme,
    invitation as invitationScheme,
    member as memberScheme,
    organization as organizationScheme,
    session as sessionScheme,
    team as teamScheme,
    teamMember as teamMemberScheme,
    twoFactor as twoFactorScheme,
    user as userScheme,
    verification as verificationScheme
} from '../../../auth-schema.ts';
import type {User} from "better-auth/types";
import {ApiError} from "../core";
import {reconcileSharesForNewTeamMember, reconcileSharesForNewUser} from "../share";

export const trustedOrigins = [
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3004",
    "http://localhost:3005",
    "http://localhost:3006",
    "http://localhost:3007",
    "http://localhost:3008",
    "http://localhost:3009",
    "http://localhost:3010",
    "http://localhost:3011",
    "http://localhost:3012",
    "http://localhost:3013",
    "https://eigen.is"];

export const auth = betterAuth({
    database: drizzleAdapter(drizzle(getServerDataPath('users3.db')), {
        provider: "sqlite",
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
        },
    }),
    databaseHooks: {
        user: {
            create: {
                after: async (user) => {
                    await authAddUserToDefaultOrg(user);
                    await reconcileSharesForNewUser(user);
                },
            },
        },
    },
    emailAndPassword: {
        enabled: true
    },
    plugins: [
        twoFactor({
            issuer: "eigen",
            otpOptions: {
                async sendOTP({user, otp}, ctx) {
                    console.log('send otp', user, otp, ctx?.request);
                },
            },
        }),
        admin(),
        organization({
            teams: {
                enabled: true,
            },
            organizationHooks: {
                afterAddTeamMember: async ({teamMember}) => {
                    await reconcileSharesForNewTeamMember(
                        teamMember.userId,
                        teamMember.teamId,
                    );
                },
            },
        }),
    ],
    trustedOrigins,
    appName: "eigen",
    baseURL: process.env["API_URL"],
    basePath: "/auth",
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
        throw new ApiError(500, `Failed to auto-join user ${user.id} to default org: ${error instanceof Error ? error.message : String(error)}`);
    }
}

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
            },
        });
    }
    return authDrizzleDb;
}
