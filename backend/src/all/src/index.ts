import {Elysia} from "elysia";
import swagger from "@elysiajs/swagger";
import {plugin} from "./module";
import cors from "@elysiajs/cors";
import imap from "./lib/mail/imap";
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
    .get("/user", async ({user}) => {
        const mail = new imap(user);
        await mail.init();
        await mail.mailboxes_create('INBOX/test');
        await mail.messages_append('INBOX/test', 'test', 'test@eigen.eu', 'test', 'test');
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