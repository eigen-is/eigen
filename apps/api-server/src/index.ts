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
import {setupRouter} from "./routes/setup";
import {isSetupRequired} from "./lib/setup/setup";

const app = new Elysia()
    .use(swagger())
    .use(cors({
        origin: trustedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .use(setupRouter)
    .use(betterAuth)
    .onError(({set}) => {
        set.status = 400;
        return 'Uncertain state: API request failed to resolve';
    })
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

// Check setup status on startup
isSetupRequired().then(required => {
    if (required) {
        console.log('⚠️  Setup required: No users found in database');
        console.log('📋 Visit http://localhost:8000/setup to create your first admin user');
    } else {
        console.log('✅ Setup complete: Users found in database');
    }
});

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
