import type { ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import { DRIVE_TYPE_CHAT, type DrivePath } from '@workspace/lib/types/drive';
import { Elysia, t } from 'elysia';
import { findChatsByMembers } from '../lib/chat/find-by-members';
import { requireNonGuest, requireSelf } from '../lib/core/access';
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

    // Create a chat and share it with the picked members in one server-side sequence — the
    // wizard's create step. Self-only (guests can't share): reject cross-owner callers and use the
    // raw owner Drive (getDrive), like the by-members lookup above.
    .post(
        '/chat/:ownerId/:mountId/rooms',
        async ({ params, body, user }): Promise<DrivePath> => {
            requireSelf(params.ownerId, user.id);
            requireNonGuest(user);
            const drive = await getDrive(user);

            const parentId = body.parentId ?? (await drive.ensureChatsFolder(params.mountId));
            const chat = await drive.create(params.mountId, parentId, body.fileName, DRIVE_TYPE_CHAT, user);

            // A wizard chat is born shared. The share email is suppressed (in-app notification + SSE
            // still fire, see docs/PROPOSAL_CHAT_WIZARD.md decision 6); a created-but-unshared orphan
            // is worse than a clean error, so on ACL failure purge the fresh container and rethrow.
            try {
                await drive.updateACLDelta(
                    params.mountId,
                    chat.id,
                    { add: body.members.map((email) => ({ id: email.trim().toLowerCase(), read: true, write: true })) },
                    undefined,
                    undefined,
                    user,
                    { suppressShareEmail: true },
                );
            } catch (err) {
                await drive.deletePath(params.mountId, chat.id).catch((e) => {
                    console.warn(`Failed to trash orphaned chat ${chat.id} after share failure:`, e);
                });
                await drive.permanentlyDelete(params.mountId, chat.id).catch((e) => {
                    console.warn(`Failed to purge orphaned chat ${chat.id} after share failure:`, e);
                });
                throw err;
            }

            const created = await drive.getPath(params.mountId, chat.id);
            if (!created) throw new ApiError(500, 'Failed to load created chat');
            return created;
        },
        {
            body: t.Object({
                parentId: t.Optional(t.String()),
                fileName: t.String(),
                members: t.Array(t.String(), { minItems: 1 }),
            }),
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
