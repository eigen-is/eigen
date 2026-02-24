import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive";

export const chatRouter = new Elysia({name: "chat"})
    .use(betterAuth)

    .get("/chat/:ownerId/:mountId/:chatId/messages", async ({params, query, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chat = await drive.getChat(params.mountId, params.chatId);
        const limit = query.limit ? parseInt(query.limit) : 50;
        return await chat.getMessagesForUser(user.id, limit, query.before || undefined);
    }, {
        query: t.Object({
            before: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        }),
        auth: true
    })

    .post("/chat/:ownerId/:mountId/:chatId/messages", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chat = await drive.getChat(params.mountId, params.chatId);
        return await chat.postMessage(
            user.id,
            user.email,
            body.content,
            body.type || 'message',
            body.whisperTo,
            body.replyTo,
            body.attachments,
        );
    }, {
        body: t.Object({
            content: t.String(),
            type: t.Optional(t.Union([
                t.Literal('message'),
                t.Literal('emote'),
                t.Literal('whisper'),
                t.Literal('system'),
            ])),
            whisperTo: t.Optional(t.String()),
            replyTo: t.Optional(t.String()),
            attachments: t.Optional(t.Array(t.String())),
        }),
        auth: true
    })

    .patch("/chat/:ownerId/:mountId/:chatId/messages/:messageId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chat = await drive.getChat(params.mountId, params.chatId);
        const result = await chat.editMessage(params.messageId, body.content, user.id);
        if (!result) return {success: false, error: 'Message not found or not owned by user'};
        return {success: true, message: result};
    }, {
        body: t.Object({content: t.String()}),
        auth: true
    })

    .delete("/chat/:ownerId/:mountId/:chatId/messages/:messageId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chat = await drive.getChat(params.mountId, params.chatId);
        const result = await chat.deleteMessage(params.messageId, user.id);
        return {success: result};
    }, {auth: true})

    .post("/chat/:ownerId/:mountId/:chatId/read", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chat = await drive.getChat(params.mountId, params.chatId);
        await chat.markRead(user.id, body.messageId);
        return {success: true};
    }, {
        body: t.Object({messageId: t.String()}),
        auth: true
    });
