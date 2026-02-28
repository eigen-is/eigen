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
    // Public delivery endpoint (no auth, no ownerId)
    .post("/mail/deliver/:to", async ({params, body}) => await mailboxDeliver(params.to, body as ArrayBuffer))
    // All other routes use /:ownerId/ pattern
    .get("/mail/:ownerId/mailboxes", async ({user}) => await mailboxesList(user), {auth: true})
    .get("/mail/:ownerId/mailbox/*", async ({params, user}) => await mailboxGet(user, params['*']), {auth: true})
    .post("/mail/:ownerId/mailbox", async ({body, user}) => await mailboxCreate(user, body.mailbox, body.attributes), {
        auth: true,
        body: t.Object({
            mailbox: t.String(),
            attributes: t.Optional(t.Array(t.String()))
        })
    })
    .get("/mail/:ownerId/mailbox-exists/*", async ({
                                                       params,
                                                       user
                                                   }) => await mailboxExists(user, params['*']), {auth: true})
    .get("/mail/:ownerId/message/:id", async ({params, user}) => await messageGet(user, params.id), {auth: true})
    .get("/mail/:ownerId/message/:id/download", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'message/rfc822';
        set.headers['Content-Transfer-Encoding'] = 'binary';
        set.headers['Content-Disposition'] = `attachment; filename="${params.id}.eml"`;
        return await messageGetFile(user, params.id);
    }, {auth: true})
    .delete("/mail/:ownerId/message/:id", async ({params, user}) => await messageDelete(user, params.id), {auth: true})
    .put("/mail/:ownerId/message/move", async ({
                                                   body,
                                                   user
                                               }) => await messageMove(user, body.messageId, body.targetMailbox), {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/:ownerId/message/move-to-inbox", async ({
                                                            body,
                                                            user
                                                        }) => await messageMoveToInbox(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/:ownerId/message/move-to-archive", async ({
                                                              body,
                                                              user
                                                          }) => await messageMoveToArchive(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/:ownerId/message/move-to-spam", async ({body, user}) => await messageMoveToSpam(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .put("/mail/:ownerId/message/move-to-trash", async ({
                                                            body,
                                                            user
                                                        }) => await messageMoveToTrash(user, body.messageId), {
        auth: true,
        body: t.Object({messageId: t.String()})
    })
    .post("/mail/:ownerId/message/copy", async ({
                                                    body,
                                                    user
                                                }) => await messageCopy(user, body.messageId, body.targetMailbox), {
        auth: true,
        body: t.Object({
            messageId: t.String(),
            targetMailbox: t.String()
        })
    })
    .put("/mail/:ownerId/message/draft", async ({body, user}) => await messageHandleDraft(user, body.mail), {
        auth: true,
        body: t.Object({mail: t.Any()})
    })
    .post("/mail/:ownerId/message/send", async ({body, user}) => await messageSend(user, body.mail), {
        auth: true,
        body: t.Object({mail: t.Any()})
    })
    .put("/mail/:ownerId/message/:id/read", async ({
                                                       params,
                                                       body,
                                                       user
                                                   }) => await messageSetRead(user, params.id, body.read), {
        auth: true,
        body: t.Object({
            read: t.Boolean()
        })
    })
    .get("/mail/:ownerId/message/:id/attachment/:index/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'application/octet-stream';
        set.headers['Content-Disposition'] = `attachment; filename="${params.fileName}"`;
        const attachment = await messageGetAttachment(user, params.id, Number(params.index));
        return attachment?.content ?? null;
    }, {auth: true});