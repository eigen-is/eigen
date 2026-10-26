// The drive side of the trash: moving a path to the trash, back out of it, and deleting it for good.
// Drive methods such as deletePath check the path and then call these. They close open documents,
// take away sharing, tell open tabs and write the history.

import type { DrivePath } from '@workspace/lib/types/drive';
import { isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import type { User } from '../user';
import { propagateSharedPathChange } from './acl-propagation';
import type { Drive } from './drive';
import { broadcastFileHistoryUpdated } from './sse-events';

export async function deletePath(drive: Drive, mount: Mount, item: DrivePath, user?: User): Promise<void> {
    // Read before the trash moves the item to the mount root. The breadcrumb after the move has lost the
    // old folders, and with them the folder watchers this event is for.
    const preTrashChain = user ? await mount.getBreadcrumb(item.id) : [];

    // Read before the trash for the same reason. The history broadcast at the end must still reach
    // everyone who could see the item in its old place.
    const members = user ? await drive.getEffectiveMembers(mount.id, item.id) : [];

    // Open documents close before trashPath closes their databases, so each one saves its last state.
    // Drive.deletePath refuses new opens until the trash is done.
    if (isContainerType(item.type)) {
        await closeCollabDocumentsRecursively(drive, mount, item.id);
    }

    const trashedItem = await mount.trashPath(item.id);
    // A document can move into the folder after Drive.deletePath read the paths it guards. trashPath
    // closed its database with the rest, so the document closes now, before the slow steps below, and
    // stops taking edits it can't save. The trash is in, so a close that fails is only logged.
    for (const id of [item.id, ...mount.collectDescendantIds(item.id)]) {
        if (!drive.hasCollabDocument(mount.id, id)) continue;
        await drive
            .closeCollabDocument(mount.id, id, { skipFinalSnapshot: true })
            .catch((error) => console.error(`Failed to close collab document ${id}:`, error));
    }
    drive.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, item.parentId ?? undefined);
    if (user) {
        mount.history.record({ pathId: item.id, eventType: 'trashed', actor: user });
        // The item as it was before the trash. fanOut skips paths in the trash, and this one isn't yet.
        await mount.history.fanOut({
            eventType: 'trashed',
            actor: user,
            path: item,
            chainRootIds: [item.parentId],
            verifyAncestors: preTrashChain,
        });
        // Nobody waits for it, the same as in Drive.recordFileEvent.
        broadcastFileHistoryUpdated(item.ownerId, item, members).catch(() => {});
    }

    // The sharing goes last, the same as in Drive.renamePath. It goes only once the trash is in, so a
    // trash that fails leaves it as it was. The rows keep their ACL in the trash, so the walk below
    // still finds every entry. Drive.deletePath holds the item's ACL chain, so the item's own push
    // goes out directly.
    if (trashedItem.acl) await propagateSharedPathChange(trashedItem, trashedItem.acl, null, user ?? null);
    if (isContainerType(item.type)) await pushSharingBelow(drive, mount, item.id, 'trashed', user);
}

export async function restorePath(drive: Drive, mount: Mount, pathId: string, user?: User): Promise<void> {
    const restoredItem = await mount.restorePath(pathId);
    drive.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
    // recordFileEvent reads the path again, so it walks the parent chain of the restored path.
    if (user) await drive.recordFileEvent(mount.id, pathId, user, { eventType: 'restored' });

    // The sharing comes back last, the same as in Drive.renamePath, and nobody gets an email again.
    await drive.pushSharing(mount.id, pathId, 'live', user ?? null);
    if (isContainerType(restoredItem.type)) await pushSharingBelow(drive, mount, restoredItem.id, 'live', user);
}

// Returns false when the item is gone or no longer in trash by the time the delete holds its lock.
export async function permanentlyDelete(drive: Drive, mount: Mount, item: DrivePath, user?: User): Promise<boolean> {
    // A folder's delete takes the items trashed on their own from inside it with it. Each of them gets
    // the events and the notices of a delete of its own.
    const roots = isContainerType(item.type) ? [item, ...(await mount.listTrashRootsInside(item.id))] : [item];
    const notices = user ? await Promise.all(roots.map((root) => readDeleteNotice(mount, root, user))) : [];

    if (!(await mount.permanentlyDeleteFromTrash(item.id))) return false;

    for (const [index, root] of roots.entries()) {
        // A restore can take the lock of an item trashed on its own first, and then the item stays.
        if (root !== item && (await mount.getPath(root.id))) continue;
        drive.emit(
            isContainerType(root.type) ? SSEventType.DRIVE_FOLDER_DELETED : SSEventType.DRIVE_FILE_DELETED,
            root,
        );
        const notice = notices[index];
        if (user && notice.watcherIds.length > 0) {
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

// Read access comes from the whole chain of folders, so every path below the folder with an ACL of its
// own gets its own push, each in its own ACL chain.
async function pushSharingBelow(
    drive: Drive,
    mount: Mount,
    folderId: string,
    state: 'live' | 'trashed',
    user?: User,
): Promise<void> {
    for (const child of await mount.listFolderAll(folderId)) {
        await drive.pushSharing(mount.id, child.id, state, user ?? null);
        if (isContainerType(child.type)) await pushSharingBelow(drive, mount, child.id, state, user);
    }
}

async function closeCollabDocumentsRecursively(drive: Drive, mount: Mount, pathId: string): Promise<void> {
    const path = await mount.getPath(pathId);
    if (!path) return;

    if (isCollabType(path.type)) {
        try {
            await drive.closeCollabDocument(mount.id, pathId);
        } catch (error) {
            console.error(`Failed to close collab document ${pathId}:`, error);
        }
    } else if (isContainerType(path.type)) {
        const children = await mount.listFolderAll(pathId);
        for (const child of children) {
            await closeCollabDocumentsRecursively(drive, mount, child.id);
        }
    }
}
