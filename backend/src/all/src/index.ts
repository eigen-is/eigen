import {Elysia} from "elysia";
import swagger from "@elysiajs/swagger";
import {plugin} from "./module";
import cors from "@elysiajs/cors";
import {imap_init, imap_mailboxes_create, imap_mailboxes_list, imap_messages_append} from "./lib/mail/imap";
import {betterAuth} from "./routes/auth";
import {mailRouter} from "./routes/mail";

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
    .use(betterAuth)
    .get("/user", async ({ user }) => {
        await imap_init(user);
        await imap_mailboxes_create(user, 'INBOX/test');
        await imap_messages_append(user, 'INBOX/test', 'test', 'test@eigen.eu', 'test', 'test');

        console.log(await imap_mailboxes_list(user));
        return user;
    }, {
        auth: true,
    })
    .use(mailRouter)
    .listen(8000);

export type app = typeof app;

console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);