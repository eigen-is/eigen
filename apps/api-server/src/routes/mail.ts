import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {
    mailboxCreate,
    mailboxDeliver,
    mailboxesList,
    mailboxExists,
    mailboxGet,
    messageCopy,
    messageDelete,
    messageGet,
    messageGetAttachment,
    messageGetFile,
    messageHandleDraft,
    messageMove,
    messageMoveToArchive,
    messageMoveToInbox,
    messageMoveToSpam,
    messageMoveToTrash,
    messageSend,
    messageSetRead
} from "../lib/mail/mail";

export const mailRouter = new Elysia({name: "mail"})
    .use(betterAuth)
    .get("/mail/mailboxes", async ({user}) => await mailboxesList(user), {auth: true})
    .get("/mail/mailbox/*", async ({params, user}) => await mailboxGet(user, params['*']), {auth: true})
    .post("/mail/mailbox", async ({body, user}) => await mailboxCreate(user, body.mailbox, body.attributes), {
        auth: true,
        body: t.Object({
            mailbox: t.String(),
            attributes: t.Optional(t.Array(t.String()))
        })
    })
    .get("/mail/mailbox-exists/*", async ({params, user}) => await mailboxExists(user, params['*']), {auth: true})
    .post("/mail/deliver/:to", async ({params, body}) => await mailboxDeliver(params.to, body as ArrayBuffer), {
        params: t.Object({to: t.String()})
    })
    .get("/mail/message/:id", async ({params, user}) => await messageGet(user, params.id), {
        auth: true,
        params: t.Object({id: t.String()})
    })
    .get("/mail/message/download/:id", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'message/rfc822';
        set.headers['Content-Transfer-Encoding'] = 'binary';
        set.headers['Content-Disposition'] = `attachment; filename="${params.id}.elm"`;
        return await messageGetFile(user, params.id);
    }, {
        auth: true,
        params: t.Object({id: t.String()})
    })
    .delete("/mail/message/:id", async ({params, user}) => await messageDelete(user, params.id), {
        auth: true,
        params: t.Object({id: t.String()})
    })
    .put("/mail/message/move", async ({body, user}) => await messageMove(user, body.messageId, body.targetMailbox), {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/message/moveToInbox", async ({body, user}) => await messageMoveToInbox(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/message/moveToArchive", async ({body, user}) => await messageMoveToArchive(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/message/moveToSpam", async ({body, user}) => await messageMoveToSpam(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/message/moveToTrash", async ({body, user}) => await messageMoveToTrash(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .post("/mail/message/copy", async ({body, user}) => await messageCopy(user, body.messageId, body.targetMailbox), {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/message/draft", async ({body, user}) => await messageHandleDraft(user, body.mail), {
        auth: true,
        body: t.Object({mail: t.Any()})
    })
    .post("/mail/message/send", async ({body, user}) => await messageSend(user, body.mail), {
        auth: true,
        body: t.Object({mail: t.Any()})
    })
    .put("/mail/message/read", async ({body, user}) => await messageSetRead(user, body.messageId, body.read), {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            read: t.Boolean()
        })
    })
    .get("/mail/message/:id/attachment/:index/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'application/octet-stream';
        set.headers['Content-Disposition'] = `attachment; filename="${params.fileName}"`;
        const attachment = await messageGetAttachment(user, params.id, Number(params.index));
        return attachment?.content ?? null;
    }, {
        auth: true,
        params: t.Object({id: t.String(), index: t.String(), fileName: t.String()})
    });