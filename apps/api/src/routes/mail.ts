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
    messageSetFlagged,
    messageSetRead
} from "../lib/mail/mail";

export const mailRouter = new Elysia({name: "mail"})
    .use(betterAuth)
    // Public delivery endpoint (no auth, no ownerId) — used by SMTP relay
    .post("/mail/deliver/:to", async ({params, body}) => await mailboxDeliver(params.to, body as ArrayBuffer), {
        parse: 'arrayBuffer',
        body: t.Any({maxLength: 25 * 1024 * 1024}),
    })
    // All other routes use /:ownerId/ pattern
    .get("/mail/:ownerId/mailboxes", async ({user}) => await mailboxesList(user), {auth: true})
    .get("/mail/:ownerId/mailbox/:mailboxPath", async ({params, user}) => await mailboxGet(user, params.mailboxPath), {auth: true})
    .post("/mail/:ownerId/mailbox", async ({body, user}) => await mailboxCreate(user, body.mailbox), {
        auth: true,
        body: t.Object({
            mailbox: t.String(),
        })
    })
    .get("/mail/:ownerId/mailbox-exists/:mailboxPath", async ({params, user}) => await mailboxExists(user, params.mailboxPath), {auth: true})
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
    .put("/mail/:ownerId/message/:id/flagged", async ({
                                                          params,
                                                          body,
                                                          user
                                                      }) => await messageSetFlagged(user, params.id, body.flagged), {
        auth: true,
        body: t.Object({
            flagged: t.Boolean()
        })
    })
    .get("/mail/:ownerId/message/:id/attachment/:index/:fileName", async ({params, user, set}) => {
        set.headers['Cache-Control'] = 'public, max-age=86400';
        set.headers['Expires'] = new Date(Date.now() + 86400000).toUTCString();
        set.headers['Content-Type'] = 'application/octet-stream';
        const safeName = params.fileName.replace(/[\x00-\x1f"\\]/g, '_');
        set.headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
        const attachment = await messageGetAttachment(user, params.id, Number(params.index));
        return attachment?.content ?? null;
    }, {auth: true});
