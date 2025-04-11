import Elysia from "elysia";
import swagger from "@elysiajs/swagger";
import cors from "@elysiajs/cors";
import {betterAuth} from "./routes/auth";
import {mailRouter} from "./routes/mail";
import {contactsRouter} from "./routes/contacts";
import {trustedOrigins} from "./lib/auth/auth";
import {spaceRouter} from "./routes/space";
import {driveRouter} from "./routes/drive.ts";
import {homeRouter} from "./routes/home.ts";
import {wsRouter} from "./routes/ws.ts";
import {collabRouter} from "./routes/collab";

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
    .use(spaceRouter)
    .use(driveRouter)
    .use(homeRouter)
    .use(wsRouter)
    .use(collabRouter)
    .listen(8000);

export type app = typeof app;

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
