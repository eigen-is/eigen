import {betterAuth} from "better-auth";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import * as schema from './drizzle/schema';
import {trustedOrigins} from "../..";

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