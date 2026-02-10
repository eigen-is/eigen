import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {getServerDataPath} from "../config/paths";
import {admin, organization, twoFactor} from "better-auth/plugins"
import {
    account as accountScheme,
    invitation as invitationScheme,
    member as memberScheme,
    organization as organizationScheme,
    session as sessionScheme,
    twoFactor as twoFactorScheme,
    user as userScheme,
    verification as verificationScheme
} from '../../../auth-schema.ts';

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
    "http://localhost:3010",
    "http://localhost:3011",
    "https://eigen.is"];

export const auth = betterAuth({
    database: drizzleAdapter(drizzle(getServerDataPath('users3.db')), {
        provider: "sqlite", // or "pg" or "mysql"
        schema: {
            user: userScheme,
            session: sessionScheme,
            account: accountScheme,
            verification: verificationScheme,
            twoFactor: twoFactorScheme,
            organization: organizationScheme,
            member: memberScheme,
            invitation: invitationScheme,
        },
    }),
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
        organization(),
    ],
    trustedOrigins,
    appName: "eigen",
    baseURL: process.env["API_URL"],
    basePath: "/auth",  // Auth routes at /auth/*
    secret: "+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c=",
});
