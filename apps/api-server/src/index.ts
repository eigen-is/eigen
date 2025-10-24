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
import {adminRouter} from "./routes/admin";
import {configRouter} from "./routes/config";
import {isSetupRequired} from "./lib/setup/setup";
import {isSystemConfigured} from "./lib/config/config";

const app = new Elysia()
    .use(swagger())
    .use(cors({
        origin: trustedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .use(betterAuth)
    .use(adminRouter)
    .use(configRouter)
    .onError(({error, set}) => {
        console.error('API Error:', error);
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
    .use(adminRouter)
    .listen(8000);

export type app = typeof app;

// Check setup status on startup
Promise.all([isSystemConfigured(), isSetupRequired()]).then(([systemConfigured, userSetupRequired]) => {
    if (!systemConfigured || userSetupRequired) {
        console.log('⚠️  Setup required');
        if (!systemConfigured) {
            console.log('   - System configuration needed');
        }
        if (userSetupRequired) {
            console.log('   - Admin user creation needed');
        }
        console.log('📋 Visit http://localhost:3010/admin to complete setup');
    } else {
        console.log('✅ Setup complete');
    }
});

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
