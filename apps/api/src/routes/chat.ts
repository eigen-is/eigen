import {Elysia, t} from 'elysia';
import {ApiError} from '../lib/core/errors';
import {getSharedDrive} from '../lib/drive';
import {betterAuth} from './auth';

// Chat routes allow cross-owner access (chats live inside shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
export const chatRouter = new Elysia({name: 'chat'})
    .use(betterAuth)

    .get(
        '/chat/:ownerId/:mountId/:chatId/messages',
        async ({params, query, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const chat = await drive.getChat(params.mountId, params.chatId);
            const limit = Math.min(Math.max(1, query.limit ? parseInt(query.limit, 10) : 50), 200);
            return await chat.getMessagesForUser(user.id, user.email, limit, query.before || undefined);
        },
        {
            query: t.Object({
                before: t.Optional(t.String()),
                limit: t.Optional(t.String()),
            }),
            auth: true,
        },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/messages',
        async ({params, body, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
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
        },
        {
            body: t.Object({
                content: t.String({maxLength: 50000}),
                type: t.Optional(t.Union([t.Literal('message'), t.Literal('emote'), t.Literal('whisper')])),
                whisperTo: t.Optional(t.String()),
                replyTo: t.Optional(t.String()),
                attachments: t.Optional(t.Array(t.String())),
            }),
            auth: true,
        },
    )

    .patch(
        '/chat/:ownerId/:mountId/:chatId/messages/:messageId',
        async ({params, body, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const chat = await drive.getChat(params.mountId, params.chatId);
            const result = await chat.editMessage(params.messageId, body.content, user.id);
            if (!result) return {success: false, error: 'Message not found or not owned by user'};
            return {success: true, message: result};
        },
        {
            body: t.Object({content: t.String()}),
            auth: true,
        },
    )

    .delete(
        '/chat/:ownerId/:mountId/:chatId/messages/:messageId',
        async ({params, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const chat = await drive.getChat(params.mountId, params.chatId);
            const result = await chat.deleteMessage(params.messageId, user.id);
            return {success: result};
        },
        {auth: true},
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/invite',
        async ({params, body, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.inviteToChat(params.mountId, params.chatId, body.email);
        },
        {
            body: t.Object({email: t.String()}),
            auth: true,
        },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/read',
        async ({params, body, user}) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const chat = await drive.getChat(params.mountId, params.chatId);
            await chat.markRead(user.id, body.messageId);
            return {success: true};
        },
        {
            body: t.Object({messageId: t.String()}),
            auth: true,
        },
    );
