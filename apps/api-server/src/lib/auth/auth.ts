import {betterAuth} from "better-auth";
import {BunWorkerDialect} from "kysely-bun-worker";

export const dialect = new BunWorkerDialect({
    url: "./data/users.db",
});

export const auth = betterAuth({
    database: dialect,
    emailAndPassword: {
        enabled: true
    },
    trustedOrigins: ["http://localhost:3001"],
});