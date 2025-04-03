// user middleware (compute user and session and pass to routes)
import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {
    mailboxCreate,
    mailboxDeliver,
    mailboxesList,
    mailboxExists,
    mailboxGet,
    messageCopy,
    messageHandleDraft,
    messageDelete,
    messageGet,
    messageGetAttachment,
    messageMove,
    messageMoveToArchive,
    messageMoveToInbox,
    messageMoveToSpam,
    messageMoveToTrash,
    messageSend,
    messageSetRead
} from "../lib/mail/mail";
import {type User} from "better-auth/types";

// Define types for request bodies
type CreateMailboxBody = {
    mailbox: string;
    attributes?: string[];
}

type DeliverMessageBody = ArrayBuffer;

type MessageMoveBody = {
    messageId: string;
    targetMailbox: string;
}

type MessageReadBody = {
    messageId: string;
    read: boolean;
}

type MessageDraftBody = {
    mail: any; // Using any for now, could be replaced with a proper Email type
}

export const mailRouter = new Elysia({name: "mail"})
    .use(betterAuth)
    // Mailbox routes
    .get("/mail/mailboxes", async ({user}: { user: User }) => {
        return await mailboxesList(user);
    }, {
        auth: true
    })
    .get("/mail/mailbox/*", async ({params, user}: { params: { '*': string }, user: User }) => {
        return await mailboxGet(user, params['*']);
    }, {
        auth: true,
    })
    .post("/mail/mailbox", async ({body, user}: { body: CreateMailboxBody, user: User }) => {
        return await mailboxCreate(user, body['mailbox'], body['attributes']);
    }, {
        auth: true,
        body: t.Object({
            mailbox: t.String(),
            attributes: t.Optional(t.Array(t.String()))
        })
    })
    .get("/mail/mailbox-exists/*", async ({params, user}: { params: { '*': string }, user: User }) => {
        return await mailboxExists(user, params['*']);
    }, {
        auth: true
    })
    .post("/mail/deliver/:to", async ({params, body}: { body: DeliverMessageBody, params: { 'to': string } }) => {
        return await mailboxDeliver(params.to, body);
    })
    // Message routes
    .get("/mail/message/:id", async ({params, user}: { params: { id: string }, user: User }) => {
        return await messageGet(user, params['id']);
    }, {
        auth: true,
        params: t.Object({
            id: t.String()
        })
    })
    .delete("/mail/message/:id", async ({params, user}: { params: { id: string }, user: User }) => {
        return await messageDelete(user, params['id']);
    }, {
        auth: true,
        params: t.Object({
            id: t.String()
        })
    })
    .put("/mail/message/move", async ({body, user}: { body: MessageMoveBody, user: User }) => {
        return await messageMove(user, body['messageId'], body['targetMailbox']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/message/moveToInbox", async ({body, user}: { body: { messageId: string }, user: User }) => {
        return await messageMoveToInbox(user, body['messageId']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String()
        })
    })
    .put("/mail/message/moveToArchive", async ({body, user}: { body: { messageId: string }, user: User }) => {
        return await messageMoveToArchive(user, body['messageId']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String()
        })
    })
    .put("/mail/message/moveToSpam", async ({body, user}: { body: { messageId: string }, user: User }) => {
        return await messageMoveToSpam(user, body['messageId']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String()
        })
    })
    .put("/mail/message/moveToTrash", async ({body, user}: { body: { messageId: string }, user: User }) => {
        return await messageMoveToTrash(user, body['messageId']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String()
        })
    })
    .post("/mail/message/copy", async ({body, user}: { body: MessageMoveBody, user: User }) => {
        return await messageCopy(user, body['messageId'], body['targetMailbox']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/message/draft", async ({body, user}: { body: MessageDraftBody, user: User }) => {
        return await messageHandleDraft(user, body['mail']);
    }, {
        auth: true,
        body: t.Object({
            mail: t.Any()
        })
    })
    .post("/mail/message/send", async ({body, user}: { body: MessageDraftBody, user: User }) => {
        return await messageSend(user, body['mail']);
    }, {
        auth: true,
        body: t.Object({
            mail: t.Any()
        })
    })
    .put("/mail/message/read", async ({body, user}: { body: MessageReadBody, user: User }) => {
        return await messageSetRead(user, body['messageId'], body['read']);
    }, {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            read: t.Boolean()
        })
    })
    .get("/mail/message/:id/attachment/:index/:fileName", async ({params, user, set}: {
        params: { id: string, index: number, fileName: string },
        user: User,
        set: any
    }) => {
        // Set caching headers for attachments (1 day)
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'application/octet-stream';
        set.headers['Content-Disposition'] = `attachment; filename="${params['fileName']}"`;

        const attachment = await messageGetAttachment(user, params['id'], params['index']);

        return attachment?.content ?? null;
    }, {
        auth: true,
        params: t.Object({
            id: t.String(),
            index: t.Number(),
            fileName: t.String()
        })
    })
;