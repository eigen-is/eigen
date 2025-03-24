import Elysia from "elysia";
import swagger from "@elysiajs/swagger";
import cors from "@elysiajs/cors";
import {betterAuth} from "./routes/auth";
import {mailRouter} from "./routes/mail";
import {contactsRouter} from "./routes/contacts";
import {trustedOrigins} from "./lib/auth/auth";

const app = new Elysia()
    .use(swagger())
    .use(cors({
        origin: trustedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .use(betterAuth)
    .get("/", () => "eigen|api>")
    .get("/health", () => "OK")
    .use(mailRouter)
    .use(contactsRouter)
    .listen({
        port: 8000,
        tls: {
            key: Bun.file("/etc/letsencrypt/live/eigen.is/privkey.pem"),
            cert: Bun.file("/etc/letsencrypt/live/eigen.is/fullchain.pem"),
        },
        hostname: "::",
    });

export type app = typeof app;

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);