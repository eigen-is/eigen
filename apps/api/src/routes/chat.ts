import {Elysia, t} from "elysia";
import {betterAuth} from "./auth";
import {getSharedDrive} from "../lib/drive";

export const chatRouter = new Elysia({name: "chat"})
    .use(betterAuth)

    .post("/chat/:ownerId/:mountId/:chatId/rooms", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        return await drive.createChatRoom(params.mountId, params.chatId, body.roomName);
    }, {
        body: t.Object({roomName: t.String()}),
        auth: true
    })

    .get("/chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages", async ({params, query, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chatRoom = await drive.getChatRoom(params.mountId, params.roomId);
        const limit = query.limit ? parseInt(query.limit) : 50;
        return await chatRoom.getMessagesForUser(user.id, limit, query.before || undefined);
    }, {
        query: t.Object({
            before: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        }),
        auth: true
    })

    .post("/chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chatRoom = await drive.getChatRoom(params.mountId, params.roomId);
        return await chatRoom.postMessage(
            user.id,
            user.email,
            body.content,
            body.type || 'message',
            body.whisperTo,
            body.replyTo,
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
        }),
        auth: true
    })

    .patch("/chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chatRoom = await drive.getChatRoom(params.mountId, params.roomId);
        const result = await chatRoom.editMessage(params.messageId, body.content, user.id);
        if (!result) return {success: false, error: 'Message not found or not owned by user'};
        return {success: true, message: result};
    }, {
        body: t.Object({content: t.String()}),
        auth: true
    })

    .delete("/chat/:ownerId/:mountId/:chatId/rooms/:roomId/messages/:messageId", async ({params, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chatRoom = await drive.getChatRoom(params.mountId, params.roomId);
        const result = await chatRoom.deleteMessage(params.messageId, user.id);
        return {success: result};
    }, {auth: true})

    .post("/chat/:ownerId/:mountId/:chatId/rooms/:roomId/read", async ({params, body, user}) => {
        const drive = await getSharedDrive(params.ownerId, user);
        const chatRoom = await drive.getChatRoom(params.mountId, params.roomId);
        await chatRoom.markRead(user.id, body.messageId);
        return {success: true};
    }, {
        body: t.Object({messageId: t.String()}),
        auth: true
    });
