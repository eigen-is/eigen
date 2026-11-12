// The drive side of the trash: moving a path to the trash, back out of it, and deleting it for good,
// from the trash or, for a path nobody needs back such as a failed copy, without it. Drive methods such as
// deletePath check the path and then call these. They close open documents, tell open tabs and write
// the history.

import type { DrivePath } from '@workspace/lib/types/drive';
import { isContainerType } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import type { User } from '../user';
import type { Drive } from './drive';
import { broadcastFileHistoryUpdated } from './sse-events';

export async function deletePath(drive: Drive, mount: Mount, item: DrivePath, user: User): Promise<void> {
    // Read before the trash moves the item to the mount root. The breadcrumb after the move has lost the
    // old folders, and with them the folder watchers this event is for.
    const preTrashChain = await mount.getBreadcrumb(item.id);

    // Read before the trash for the same reason. The trash takes the item away from everyone it is
    // shared with, and they must still hear that it left their view.
    const members = await drive.membersToTell(mount.id, item.id);

    // The mark comes first: after it an open is a 404 and a sync writes to the trashed row's key, so what was
    // open under the item closes after it and saves its last edits into the trash.
    const trashedItem = await mount.trashPath(item.id);
    await closeOpenDocumentsUnder(drive, mount, item.id);
    drive.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, { oldParentId: item.parentId, members });
    mount.history.record({ pathId: item.id, eventType: 'trashed', actor: user });
    // The item as it was before the trash. fanOut skips paths in the trash, and this one isn't yet.
    await mount.history.fanOut({
        eventType: 'trashed',
        actor: user,
        path: item,
        chainRootIds: [item.parentId],
        verifyAncestors: preTrashChain,
    });
    // Nobody waits for it, so a failed broadcast never fails the trash.
    broadcastFileHistoryUpdated(item.ownerId, item, members).catch(() => {});
}

export async function restorePath(drive: Drive, mount: Mount, pathId: string, user: User): Promise<void> {
    const restoredItem = await mount.restorePath(pathId);
    drive.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
    // recordFileEvent reads the path again, so it walks the parent chain of the restored path.
    await drive.recordFileEvent(mount.id, pathId, user, { eventType: 'restored' });
}

// Returns false when the item is gone or no longer in trash by the time the delete holds its lock.
export async function permanentlyDelete(drive: Drive, mount: Mount, item: DrivePath, user: User): Promise<boolean> {
    // A folder's delete takes the items trashed on their own from inside it with it. Each of them gets
    // the events and the notices of a delete of its own.
    const roots = isContainerType(item.type) ? [item, ...(await mount.listTrashRootsInside(item.id))] : [item];
    const notices = await Promise.all(roots.map((root) => readDeleteNotice(mount, root, user)));
    // The delete takes the path that the members are read from. Everything here is in the trash, which
    // only the owner, or a team's members, can see, so one read serves every root. The item can be gone
    // already, taken by the delete of a folder around it, and then there is nobody to tell. Any other
    // failed read costs only the members' events, so it is logged and the delete goes on.
    const members = await drive.getEffectiveMembers(mount.id, item.id).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 404)) {
            console.error(`Failed to read the members of ${item.id} before its delete:`, error);
        }
        return [];
    });

    if (!(await mount.permanentlyDeleteFromTrash(item.id))) return false;

    for (const [index, root] of roots.entries()) {
        // A restore can take the lock of an item trashed on its own first, and then the item stays.
        if (root !== item && (await mount.getPath(root.id))) continue;
        drive.emit(
            isContainerType(root.type) ? SSEventType.DRIVE_FOLDER_DELETED : SSEventType.DRIVE_FILE_DELETED,
            root,
            { members },
        );
        const notice = notices[index];
        if (notice.watcherIds.length > 0) {
            await mount.history.notifyWatchers(notice.watcherIds, {
                eventType: 'deleted',
                actor: user,
                itemName: root.name,
                pathType: root.type,
                tagPathId: root.id,
                verifyAncestors: notice.verifyAncestors,
            });
        }
    }
    return true;
}

// A copy that failed part way is deleted for good. In the trash its bytes would still count against the
// owner's space, and a writer from another drive can't empty that trash.
// Someone can still have put their own path in the half-built folder, or shared a part of it. Then it
// goes to the trash like any other path, so nothing of theirs is lost.
export async function deleteFailedCopy(
    drive: Drive,
    mount: Mount,
    item: DrivePath,
    createdIds: ReadonlySet<string>,
    user: User,
): Promise<void> {
    if (!(await holdsOnlyCopy(mount, item, createdIds))) return deletePath(drive, mount, item, user);
    return deleteForGood(drive, mount, item);
}

// Deletes a live path without the trash, such as the source of a move whose bytes went into the file it replaced.
export async function deleteForGood(drive: Drive, mount: Mount, item: DrivePath): Promise<void> {
    const members = await drive.getEffectiveMembers(mount.id, item.id);
    // A document opened under the path between this close and the delete loses its database under the editor,
    // which logs until its socket's read check closes it. The path goes for good either way.
    await closeOpenDocumentsUnder(drive, mount, item.id);
    await mount.deletePath(item.id);
    drive.emit(isContainerType(item.type) ? SSEventType.DRIVE_FOLDER_DELETED : SSEventType.DRIVE_FILE_DELETED, item, {
        members,
    });
}

// True when the copy made the path and everything below it, and nobody shared any of it since.
async function holdsOnlyCopy(mount: Mount, item: DrivePath, createdIds: ReadonlySet<string>): Promise<boolean> {
    if (!createdIds.has(item.id) || item.acl?.length) return false;
    for (const child of await mount.listFolderAll(item.id)) {
        if (!(await holdsOnlyCopy(mount, child, createdIds))) return false;
    }
    return true;
}

// Closes every collab document open at or below the path, then every database still open there, such as a
// chat's data.db. The trash or the delete goes on either way, so a close that fails is only logged.
async function closeOpenDocumentsUnder(drive: Drive, mount: Mount, pathId: string): Promise<void> {
    const ids = [pathId, ...mount.collectDescendantIds(pathId)];
    const logFailure = (id: string) => (error: unknown) => console.error(`Failed to close ${id}:`, error);
    for (const id of ids) {
        await drive.closeCollabDocument(mount.id, id, { skipFinalSnapshot: true }).catch(logFailure(id));
    }
    for (const id of ids) await mount.closeDatabase(id, { skipFinalSnapshot: true }).catch(logFailure(id));
}

// A deleted path gets no history row, because deleting the path deletes its rows too. The watchers only
// get a notification. Who watches, and the folders it was trashed from, are read before the delete
// removes them.
async function readDeleteNotice(
    mount: Mount,
    item: DrivePath,
    user: User,
): Promise<{ watcherIds: string[]; verifyAncestors: DrivePath[] }> {
    const trashedFrom = await mount.getTrashedFrom(item.id);
    const chain = [...(trashedFrom ? await mount.getBreadcrumb(trashedFrom) : []), item];
    return {
        watcherIds: mount.history.collectWatcherIds(trashedFrom ? [item.id, trashedFrom] : [item.id], user.id),
        // The item joins the chain, so someone who watched a file shared with them directly still
        // qualifies. The chain is checked as it was before the trash, because a path in the trash lets
        // nobody but the owner in. The folder the item came from can be in the trash too.
        verifyAncestors: chain.map((path) => ({ ...path, trashedAt: null })),
    };
}
