import type { ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import { Elysia, t } from 'elysia';
import { findChatsByMembers } from '../lib/chat/find-by-members';
import { requireSelf } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { getDrive, getSharedDrive } from '../lib/drive';
import { betterAuth } from './auth';
import { attachmentReferenceSchema } from './shared-schemas';

// Chat routes allow cross-owner access (chats live inside shared/team drives).
// Access control is enforced by getSharedDrive() → SharedDrive ACL checks.
export const chatRouter = new Elysia({ name: 'chat' })
    .use(betterAuth)

    // Chats whose current members exactly match a picked set — the wizard's open-don't-duplicate
    // lookup. Reads the caller's own mounts + shared-with-me mirror only, so it runs on the caller's
    // Home: reject cross-owner callers and use the raw owner Drive (getDrive), not the ACL wrapper.
    .get(
        '/chat/:ownerId/rooms/by-members',
        async ({ params, query, user }): Promise<{ matches: ChatMatch[] }> => {
            requireSelf(params.ownerId, user.id);
            const emails = (query.emails ?? '')
                .split(',')
                .map((e) => e.trim())
                .filter((e) => e.length > 0);
            if (emails.length === 0) throw new ApiError(400, 'At least one email is required');
            const drive = await getDrive(user);
            return { matches: await findChatsByMembers(drive, user, emails) };
        },
        {
            query: t.Object({ emails: t.Optional(t.String()) }),
            auth: true,
        },
    )

    .get(
        '/chat/:ownerId/:mountId/:chatId/messages',
        async ({ params, query, user }): Promise<ChatMessage[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const chat = await drive.getChat(params.mountId, params.chatId);
            return await chat.getMessagesForUser(user.id, user.email, query.limit ?? 50, query.before || undefined);
        },
        {
            query: t.Object({
                before: t.Optional(t.String()),
                limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
            }),
            auth: true,
        },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/messages',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const chat = await drive.getChat(params.mountId, params.chatId);
            return await chat.postMessage(
                user,
                body.content,
                body.type || 'message',
                body.whisperTo,
                body.replyTo,
                body.attachments,
            );
        },
        {
            body: t.Object({
                content: t.String({ maxLength: 50000 }),
                type: t.Optional(t.Union([t.Literal('message'), t.Literal('emote'), t.Literal('whisper')])),
                whisperTo: t.Optional(t.String()),
                replyTo: t.Optional(t.String()),
                attachments: t.Optional(t.Array(t.Union([t.String(), attachmentReferenceSchema]))),
            }),
            auth: true,
        },
    )

    .patch(
        '/chat/:ownerId/:mountId/:chatId/messages/:messageId',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const chat = await drive.getChat(params.mountId, params.chatId);
            return await chat.editMessage(params.messageId, body.content, user.id);
        },
        {
            body: t.Object({ content: t.String() }),
            auth: true,
        },
    )

    .delete(
        '/chat/:ownerId/:mountId/:chatId/messages/:messageId',
        async ({ params, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
                throw new ApiError(403, 'No write permission');
            }
            const chat = await drive.getChat(params.mountId, params.chatId);
            await chat.deleteMessage(params.messageId, user.id);
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/invite',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.inviteToChat(params.mountId, params.chatId, body.email, user);
        },
        {
            body: t.Object({ email: t.String() }),
            auth: true,
        },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/read',
        async ({ params, body, user }) => {
            const drive = await getSharedDrive(params.ownerId, user);
            const chat = await drive.getChat(params.mountId, params.chatId);
            await chat.markRead(user.id, body.messageId);
            return { success: true };
        },
        {
            body: t.Object({ messageId: t.String() }),
            auth: true,
        },
    );
