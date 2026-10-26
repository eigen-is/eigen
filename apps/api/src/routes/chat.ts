// The chat HTTP routes, for example the wizard that creates a chat with its members, and the messages
// of one chat room. The room is a .eigenchat file in Drive, so a chat in another owner's drive goes
// through SharedDrive, which checks the access before ChatRoom does the work.

import type { ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_CHAT, stripEigenExtension, withEigenExtension } from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { MAX_EMAIL_LENGTH, validateEmailTarget } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { findChatsByMembers } from '../lib/chat/find-by-members';
import { requireNonGuest, requireSelf, requireTeamAccess } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import type { Drive } from '../lib/drive';
import { getDrive, getSharedDrive } from '../lib/drive';
import { getUniqueFileName } from '../lib/drive/naming';
import { getTeamHome } from '../lib/home';
import { foldName } from '../lib/mount/names';
import { betterAuth } from './auth';
import { attachmentReferenceSchema } from './shared-schemas';

const MAX_CHAT_MEMBERS = 100;

// The members of a person chat are email addresses. An owner id, such as `team_…` or a bare user id,
// would pass the ACL check, so it is refused here, before anything is created.
function normalizeMemberEmails(raw: string[]): string[] {
    const emails = raw.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    if (emails.length > MAX_CHAT_MEMBERS) throw new ApiError(422, `A chat takes at most ${MAX_CHAT_MEMBERS} members`);
    for (const email of emails) {
        const error = validateEmailTarget(email, 'Member');
        if (error) throw new ApiError(422, error);
    }
    return emails;
}

// A chat route may serve another owner's chat, because chats live in shared and team drives. The
// routes of one chat go through getSharedDrive, which checks the access. The two wizard routes below
// use the Drive itself, behind requireSelf or requireTeamAccess.
export const chatRouter = new Elysia({ name: 'chat' })
    .use(betterAuth)

    // The wizard looks for a chat with the same members first, so it opens that one instead of making a
    // second. It reads only the caller's own Home, so requireSelf and the Drive itself are enough.
    .get(
        '/chat/:ownerId/rooms/by-members',
        async ({ params, query, user }): Promise<{ matches: ChatMatch[] }> => {
            requireSelf(params.ownerId, user.id);
            const emails = normalizeMemberEmails((query.emails ?? '').split(','));
            if (emails.length === 0) throw new ApiError(400, 'At least one email is required');
            const drive = await getDrive(user);
            return { matches: await findChatsByMembers(drive, user, emails) };
        },
        {
            // One address plus its comma per member, so the string cap matches the member cap.
            query: t.Object({
                emails: t.Optional(t.String({ maxLength: MAX_CHAT_MEMBERS * (MAX_EMAIL_LENGTH + 1) })),
            }),
            auth: true,
        },
    )

    // The wizard's create step: the chat is created and shared in one request, in the `Chats` folder
    // unless the client names one. A team chat takes no members, because the team's members are in it.
    .post(
        '/chat/:ownerId/:mountId/rooms',
        async ({ params, body, user }): Promise<DrivePath> => {
            requireNonGuest(user);

            const owner = parseOwnerId(params.ownerId);
            const isTeam = owner.type === 'team';
            let drive: Drive;
            if (isTeam) {
                await requireTeamAccess(user.id, owner.id);
                drive = (await getTeamHome(params.ownerId)).drive;
            } else {
                requireSelf(params.ownerId, user.id);
                drive = await getDrive(user);
            }

            const members = normalizeMemberEmails(body.members ?? []);
            if (!isTeam && members.length === 0) throw new ApiError(422, 'At least one member is required');
            // The wizard checks this too, but the route must, because an empty name would create and share
            // a bare '.eigenchat' dotfile.
            let fileName = body.fileName.trim().normalize('NFC');
            if (!fileName) throw new ApiError(422, 'A chat name is required');

            const parentId = body.parentId ?? (await drive.ensureChatsFolder(params.mountId));

            // A chat the wizard named gets a free name beside its siblings, and a name the user typed is a
            // 409 on a clash. Two creates of one name at once can both pass this check, and then the
            // unique index answers 409 for the second. The free name is picked with the extension on,
            // because Drive.create adds it again.
            if (body.dedupeName) {
                const desired = withEigenExtension(fileName, DRIVE_TYPE_CHAT);
                const siblings = await drive.getFolderContents(params.mountId, parentId);
                const used = new Set(siblings.map((s) => foldName(s.name)));
                if (used.has(foldName(desired))) {
                    fileName = stripEigenExtension(getUniqueFileName(desired, used));
                }
            }
            const chat = await drive.create(params.mountId, parentId, fileName, DRIVE_TYPE_CHAT, user);

            // A wizard chat is shared from the start. When the share fails, the new chat goes again
            // instead of staying unshared. No share email goes out, but the notification and the event
            // still do.
            if (!isTeam) {
                try {
                    await drive.updateACLDelta(
                        params.mountId,
                        chat.id,
                        { add: members.map((email) => ({ id: email, read: true, write: true })) },
                        undefined,
                        undefined,
                        user,
                        { suppressShareEmail: 'registered' },
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
            }

            const created = await drive.getPath(params.mountId, chat.id);
            if (!created) throw new ApiError(500, 'Failed to load created chat');
            return created;
        },
        {
            body: t.Object({
                parentId: t.Optional(t.String()),
                fileName: t.String({ maxLength: 255 }),
                members: t.Optional(t.Array(t.String({ maxLength: MAX_EMAIL_LENGTH }), { maxItems: MAX_CHAT_MEMBERS })),
                dedupeName: t.Optional(t.Boolean()),
            }),
            auth: true,
        },
    )

    .get(
        '/chat/:ownerId/:mountId/:chatId/messages',
        async ({ params, query, user }): Promise<ChatMessage[]> => {
            const drive = await getSharedDrive(params.ownerId, user);
            const chat = await drive.getChat(params.mountId, params.chatId);
            return await chat.getMessagesForUser(user.email, query.limit ?? 50, query.before || undefined);
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
            return await chat.editMessage(params.messageId, body.content, user.email);
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
            await chat.deleteMessage(params.messageId, user.email);
            return { success: true };
        },
        { auth: true },
    )

    .post(
        '/chat/:ownerId/:mountId/:chatId/invite',
        async ({ params, body, user }) => {
            // An invite shares the chat, which a guest may not, as on the ACL route.
            requireNonGuest(user);
            const drive = await getSharedDrive(params.ownerId, user);
            return await drive.inviteToChat(params.mountId, params.chatId, body.email, user);
        },
        {
            body: t.Object({ email: t.String({ maxLength: MAX_EMAIL_LENGTH }) }),
            auth: true,
        },
    );
