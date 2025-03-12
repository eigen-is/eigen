// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getMailbox, getMailboxes} from "../lib/mail/mail";

export const mailRouter = new Elysia({name: "mail"})
    .use(betterAuth)
    .get("/mail/mailboxes", async ({ user}) => await getMailboxes(user), {
        auth: true
    })
    .get("/mail/mailbox/*", async ({ params, user}) => await getMailbox(user, params['*']), {
        auth: true,
    })
;