import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import * as schema from './drizzle/schema';

export const trustedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3004",
    "http://localhost:3005",
    "https://eigen.is"];

export const auth = betterAuth({
    database: drizzleAdapter({
        db: drizzle('./data/users.db', {schema}),
    }, {
        provider: "sqlite", // or "pg" or "mysql"
    }),
    emailAndPassword: {
        enabled: true
    },
    trustedOrigins,
});