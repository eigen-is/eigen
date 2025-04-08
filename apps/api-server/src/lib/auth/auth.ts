import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {admin, organization, twoFactor} from "better-auth/plugins"
import {account as accountScheme, session as sessionScheme, user as userScheme, verification as verificationScheme, twoFactor as twoFactorScheme, organization as organizationScheme, member as memberScheme, invitation as invitationScheme} from '../../../auth-schema.ts';

export const trustedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3004",
    "http://localhost:3005",
    "http://localhost:3006",
    "https://eigen.is"];

export const auth = betterAuth({
    database: drizzleAdapter(drizzle('./data/users3.db'), {
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
                async sendOTP({ user, otp }, request) {
                    // send otp to user (sms or something)
                    console.log('send otp', user, otp, request);
                },
            },
        }),
        admin(),
        organization(),
    ],
    trustedOrigins,
    appName: "eigen",
    baseURL: process.env["API_URL"],
    basePath: "/api/auth",
    secret: "+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c=",
});
