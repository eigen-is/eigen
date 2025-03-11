import { Elysia } from "elysia";
import swagger from "@elysiajs/swagger";
import {plugin} from "./module";
import cors from "@elysiajs/cors";
import {auth} from "./lib/auth/auth";
import {imap_init, imap_mailboxes_create, imap_messages_append} from "./lib/mail/imap";

const app = new Elysia()
    .use(swagger())
    .get("/test", "From test")
    .use(plugin)
    .use(cors({
        origin: "http://localhost:3001",
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    }))
    .mount(auth.handler)
    .macro({
        auth: {
            async resolve({ error, request: { headers } }) {
                const session = await auth.api.getSession({
                    headers,
                });

                if (!session) return error(401);

                return {
                    user: session.user,
                    session: session.session,
                };
            },
        },
    })
    .get("/user", async ({ user }) => {
        await imap_init(user);
        await imap_mailboxes_create(user, 'INBOX');
        await imap_messages_append(user, 'INBOX', 'test', 'test@eigen.eu', 'test', 'test');
        return user;
    }, {
        auth: true,
    })
    .listen(8000);

export type app = typeof app;

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);