import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {twoFactor, admin, organization} from "better-auth/plugins"
import {account, session, user, verification} from '../../../auth-schema.ts';

export const trustedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3004",
    "http://localhost:3005",
    "https://eigen.is"];

export const auth = betterAuth({
    database: drizzleAdapter(drizzle('./data/users3.db'), {
        provider: "sqlite", // or "pg" or "mysql"
        schema: {
            user,
            session,
            verification,
            account,
        },
    }),
    emailAndPassword: {
        enabled: true
    },
    plugins: [
        twoFactor(),
        admin(),
        organization(),
    ],
    trustedOrigins,
    appName: "eigen",
    baseURL: process.env["API_URL"],
    basePath: "/api/auth",
    secret: "+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c=",
});
