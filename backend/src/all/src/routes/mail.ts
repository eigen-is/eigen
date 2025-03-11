// user middleware (compute user and session and pass to routes)
import {Elysia} from "elysia";
import {betterAuth} from "./auth";
import {getMailboxes} from "../lib/mail/mail";

export const mailRouter = new Elysia({name: "mail", prefix: "mail"})
    .use(betterAuth)
    .get("mailboxes", async ({user}) => {
        const mailboxes = await getMailboxes(user);
        console.log(mailboxes);
        return mailboxes;
    }, {
        auth: true,
    })