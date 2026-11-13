// The chat and comment work of a drive: the folder new chats go in, the comment row a new thread in a document gets,
// and a thread's status and assignee in the document's comment index. Drive methods such as create and
// assignComment call these. A change to the index writes the history and reaches every open tab of the document.

import { CHATS_FOLDER_NAME } from '@workspace/lib/types/chat';
import { DRIVE_TYPE_FOLDER } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { CARD_TITLE_MAX_LENGTH } from '@workspace/lib/types/file-history';
import { withCommentIndex } from '../chat';
import { broadcastCommentIndexUpdated } from '../chat/sse-events';
import { ApiError } from '../core';
import type { User } from '../user';
import { propagateAssignment } from './assignment-propagation';
import type { Drive } from './drive';

// The folder new chats go in, looked up by name every time, so the user may rename, move or delete it. A file of
// that name sends new chats to the mount root.
export async function ensureChatsFolder(drive: Drive, mountId: string, user: User): Promise<string> {
    const root = await drive.getRootFolder(mountId);
    if (!root) throw new Error(`Mount '${mountId}' has no root folder`);

    const existing = await drive.getChildByName(mountId, root.id, CHATS_FOLDER_NAME);
    if (existing) return existing.type === DRIVE_TYPE_FOLDER ? existing.id : root.id;

    // Drive.createFolder tells other tabs about the new folder. Two first chats at once both try to
    // create it, and the one that loses the race uses the folder of the winner.
    try {
        return (await drive.createFolder(mountId, root.id, CHATS_FOLDER_NAME, user)).id;
    } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
            const winner = await drive.getChildByName(mountId, root.id, CHATS_FOLDER_NAME);
            if (winner) return winner.type === DRIVE_TYPE_FOLDER ? winner.id : root.id;
        }
        throw err;
    }
}

// A chat created inside a document is a comment thread, so it gets its row in the document's
// comment index. A chat on its own has no document, and nothing to seed.
export async function seedCommentRow(
    drive: Drive,
    mountId: string,
    chatPathId: string,
    parentId: string,
    createdBy: string,
): Promise<void> {
    const container = await drive.findContainerPath(mountId, parentId);
    if (!container) return;
    const chatPath = await drive.getPath(mountId, chatPathId);
    if (!chatPath) return;
    await withCommentIndex(drive, mountId, container.id, (index) => index.ensureComment(chatPath.name, createdBy));
}

// The server's comment index holds who is assigned, so the history row is written here and not from a client event,
// and only for an assignment. The assignee gets a direct notification, so the watchers' copy skips them.
export async function assignComment(
    drive: Drive,
    ownerId: string,
    mountId: string,
    pathId: string,
    chatName: string,
    assigneeEmail: string | null,
    user: User,
    title?: string,
): Promise<void> {
    const assignee = assigneeEmail ? assigneeEmail.toLowerCase() : null;
    // Read once for the check and the broadcast, because it walks the whole ACL.
    let members: EffectiveMember[] | undefined;
    if (assignee) {
        members = await drive.getEffectiveMembers(mountId, pathId);
        if (!members.some((member) => member.email === assignee)) {
            throw new ApiError(400, 'Assignee is not a member of this document');
        }
    }
    const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
    const changed = await withCommentIndex(drive, mountId, pathId, async (index) => {
        const current = await index.get(chatName);
        if (!current) throw new ApiError(404, 'Comment thread not found');
        // The client sends the card title, which may have changed in the same edit. So the title is
        // saved even when the assignee stays the same.
        if (card) await index.setTitle(chatName, card);
        const assigneeChanged = current.assignee !== assignee;
        if (assigneeChanged) await index.assign(chatName, assignee);
        return assigneeChanged;
    });
    if (changed && assignee) {
        await drive.recordFileEvent(
            mountId,
            pathId,
            user,
            { eventType: 'assigned', details: { assignee, card, chatName } },
            { excludeEmails: new Set([assignee]) },
        );
    }
    broadcastCommentIndexUpdated(drive, ownerId, mountId, pathId, members).catch(() => {});
    if (changed && assignee && assignee !== user.email.toLowerCase()) {
        // The assignment stands whatever happens to the notice, such as a home a restore holds.
        await drive
            .resolveFile(mountId, pathId)
            .then(({ path }) => propagateAssignment(path, chatName, assignee, user, card))
            .catch((err) => console.error('Failed to propagate assignment:', err));
    }
}

export async function setCommentStatus(
    drive: Drive,
    ownerId: string,
    mountId: string,
    pathId: string,
    chatName: string,
    status: 'resolved' | 'open',
    user: User,
    title?: string,
): Promise<void> {
    const card = title?.slice(0, CARD_TITLE_MAX_LENGTH);
    await withCommentIndex(drive, mountId, pathId, async (index) => {
        if (!(await index.get(chatName))) throw new ApiError(404, 'Comment thread not found');
        if (card) await index.setTitle(chatName, card);
        if (status === 'resolved') await index.resolve(chatName, user.email);
        else await index.reopen(chatName);
    });
    const eventType = status === 'resolved' ? 'resolved' : 'reopened';
    await drive.recordFileEvent(mountId, pathId, user, { eventType, details: { card, chatName } });
    broadcastCommentIndexUpdated(drive, ownerId, mountId, pathId).catch(() => {});
}
