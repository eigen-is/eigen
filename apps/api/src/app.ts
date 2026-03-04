import Elysia from "elysia";
import {ApiError} from "./lib/core/errors";
import swagger from "@elysiajs/swagger";
import cors from "@elysiajs/cors";
import {betterAuth} from "./routes/auth";
import {mailRouter} from "./routes/mail";
import {contactsRouter} from "./routes/contacts";
import {trustedOrigins} from "./lib/auth/auth";
import {spaceRouter} from "./routes/space";
import {publicRouter} from "./routes/public";
import {driveRouter} from "./routes/drive.ts";
import {homeRouter} from "./routes/home.ts";
import {collabRouter} from "./routes/collab";
import {sseRouter} from "./routes/sse";
import {setupRouter} from "./routes/setup";
import {chatRouter} from "./routes/chat";

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

    .use(mailRouter)
    .use(contactsRouter)
    .use(spaceRouter)
    .use(publicRouter)
    .use(driveRouter)
    .use(homeRouter)
    .use(collabRouter)
    .use(chatRouter)
    .use(sseRouter)

    .onError(({error, set}) => {
        const err = error as Error;
        if (err instanceof ApiError) {
            set.status = err.status;
            return err.message;
        }
        console.error('API Error:', err);
        set.status = 500;
        return 'Internal server error';
    })
    .get("/", () => "eigen|api>")
    .get("/health", () => "OK");

export type App = typeof app;
