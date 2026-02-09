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
import {collabRouter} from "./routes/collab";
import {adminRouter} from "./routes/admin";
import {configRouter} from "./routes/config";
import {sseRouter} from "./routes/sse";
import {setupRouter} from "./routes/setup";

export const app = new Elysia()
    .use(swagger())
    .use(cors({
        origin: trustedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .use(betterAuth)
    .use(setupRouter)
    .use(configRouter)

    .use(adminRouter)
    .use(mailRouter)
    .use(contactsRouter)
    .use(spaceRouter)
    .use(driveRouter)
    .use(homeRouter)
    .use(collabRouter)
    .use(sseRouter)

    .onError(({error, set}) => {
        console.error('API Error:', error);
        set.status = 400;
        return 'Uncertain state: API request failed to resolve';
    })
    .get("/", () => "eigen|api>")
    .get("/health", () => "OK");

export type App = typeof app;
