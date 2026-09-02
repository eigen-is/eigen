import type { ChatMatch, ChatMessage } from '@workspace/lib/types/chat';
import { DRIVE_TYPE_CHAT, type DrivePath, stripEigenExtension, withEigenExtension } from '@workspace/lib/types/drive';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { MAX_EMAIL_LENGTH, validateEmailTarget } from '@workspace/lib/validation';
import { Elysia, t } from 'elysia';
import { findChatsByMembers } from '../lib/chat/find-by-members';
import { requireNonGuest, requireSelf, requireTeamAccess } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { type Drive, getDrive, getSharedDrive } from '../lib/drive';
import { getUniqueFileName } from '../lib/drive/naming';
import { getTeamHome } from '../lib/home';
import { betterAuth } from './auth';
import { attachmentReferenceSchema } from './shared-schemas';

const MAX_CHAT_MEMBERS = 100;

// Person-mode members are email addresses by contract — reject owner-shaped ids (`team_*`,
// bare user ids would pass the generic ACL validator) before any folder or chat side effect.
function normalizeMemberEmails(raw: string[]): string[] {
    const emails = raw.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    if (emails.length > MAX_CHAT_MEMBERS) throw new ApiError(422, `A chat takes at most ${MAX_CHAT_MEMBERS} members`);
    for (const email of emails) {
        const error = validateEmailTarget(email, 'Member');
        if (error) throw new ApiError(422, error);
    }
    return emails;
}

// Chat routes allow cross-owner access (chats live inside shared/team drives).
// Access control: the :chatId routes go through getSharedDrive() (SharedDrive ACL checks); the two
// wizard routes below are escape-hatch raw Drive behind requireSelf/requireTeamAccess guards.
export const chatRouter = new Elysia({ name: 'chat' })
    .use(betterAuth)

    // The wizard's open-don't-duplicate lookup — reads only the caller's own Home, hence
    // requireSelf + raw Drive.
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

    // The wizard's create step: create + share in one server-side sequence, parent defaulting to
    // the lazily-ensured `chats` folder. Team chats take no members — membership is implicit.
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
            // The wizard guards this client-side, but the API contract must too — an empty name
            // would create (and share) a bare '.eigenchat' dotfile.
            let fileName = body.fileName.trim();
            if (!fileName) throw new ApiError(422, 'A chat name is required');

            const parentId = body.parentId ?? (await drive.ensureChatsFolder(params.mountId));

            // Auto-named chats dedupe against a sibling snapshot; user-typed names 409 on conflict.
            // Concurrent same-name creates can slip past the snapshot — the unique index 409s the
            // loser (the race net every create path shares). Dedupe in the full-name space —
            // Drive.create re-appends the extension.
            if (body.dedupeName) {
                const desired = withEigenExtension(fileName, DRIVE_TYPE_CHAT);
                const siblings = await drive.getFolderContents(params.mountId, parentId);
                const used = new Set(siblings.map((s) => s.name.toLowerCase()));
                if (used.has(desired.toLowerCase())) {
                    fileName = stripEigenExtension(getUniqueFileName(desired, used));
                }
            }
            const chat = await drive.create(params.mountId, parentId, fileName, DRIVE_TYPE_CHAT, user);

            // A wizard chat is born shared — on ACL failure purge the fresh container rather than
            // leave an unshared orphan. Share email suppressed; in-app notification + SSE still fire.
            if (!isTeam) {
                try {
                    await drive.updateACLDelta(
                        params.mountId,
                        chat.id,
                        { add: members.map((email) => ({ id: email, read: true, write: true })) },
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
            body: t.Object({ email: t.String({ maxLength: MAX_EMAIL_LENGTH }) }),
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
