import { type DrivePath, isChatType, isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import type { User } from '../user';
import { propagateACLChange } from './acl-propagation';
import type Drive from './drive';

// Trash lifecycle bodies. Drive's deletePath/restorePath/permanentlyDelete keep their
// liveness + permission checks and delegate here (the versioning/restore.ts pattern).

export async function deletePath(drive: Drive, mount: Mount, item: DrivePath, user?: User): Promise<void> {
    // Capture BEFORE trashPath re-parents the item to the mount root — the
    // post-trash breadcrumb would lose the old folder's ACL and silently skip
    // exactly the folder-watchers this event is for.
    const preTrashChain = user ? await mount.getBreadcrumb(item.id) : [];

    // Close collab docs BEFORE setting trashedAt (they use listFolderAll internally)
    if (isContainerType(item.type)) {
        await closeCollabDocumentsRecursively(drive, mount, item.id);
        await propagateACLRemovalRecursively(mount, item.id);
    } else {
        if (isCollabType(item.type)) {
            try {
                await drive.closeCollabDocument(mount.id, item.id);
            } catch (e) {
                console.error(`Failed to close collab document ${item.id}:`, e);
            }
        }
        if (item.acl) {
            await propagateACLChange(item, item.acl, null, null);
        }
    }

    const trashedItem = await mount.trashPath(item.id);
    drive.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, item.parentId ?? undefined);
    if (user) {
        await mount.history.record({ pathId: item.id, eventType: 'trashed', actor: user });
        // path: pre-trash snapshot — trashedAt is still null so the fan-out guard passes
        await mount.history.fanOut({
            eventType: 'trashed',
            actor: user,
            path: item,
            chainRootIds: [item.parentId],
            verifyAncestors: preTrashChain,
        });
    }
}

export async function restorePath(drive: Drive, mount: Mount, pathId: string, user?: User): Promise<void> {
    const restoredItem = await mount.restorePath(pathId);

    // Re-propagate ACL
    if (restoredItem.acl) {
        await propagateACLChange(restoredItem, null, restoredItem.acl, null);
    }
    // For containers, re-propagate for descendants with ACL
    if (isContainerType(restoredItem.type)) {
        await propagateACLRestoreRecursively(mount, restoredItem.id);
    }

    drive.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
    // recordFileEvent re-fetches the path, so it sees the post-restore row
    // (trashedAt cleared, original parentId) — the chain it walks is the restored one
    if (user) await drive.recordFileEvent(mount.id, pathId, user, 'restored');
}

export async function permanentlyDelete(drive: Drive, mount: Mount, item: DrivePath, user?: User): Promise<void> {
    // Notification-only ('deleted' has no history row — the FK cascade would kill
    // it instantly). Capture watchers + the trashedFrom id that justifies the
    // notification BEFORE the delete removes the path_watchers rows.
    let watcherIds: string[] = [];
    let trashedFrom: string | null = null;
    if (user) {
        trashedFrom = await mount.getTrashedFrom(item.id);
        watcherIds = mount.history.collectWatcherIds(trashedFrom ? [item.id, trashedFrom] : [item.id], user.id);
    }

    await mount.permanentlyDeleteFromTrash(item.id);

    if (isContainerType(item.type) || isCollabType(item.type) || isChatType(item.type)) {
        drive.emit(SSEventType.DRIVE_FOLDER_DELETED, item);
    } else {
        drive.emit(SSEventType.DRIVE_FILE_DELETED, item);
    }

    if (user && watcherIds.length > 0) {
        // The item itself joins the chain so direct-file-share watchers still verify
        // (the trashedFrom folder survives the delete, so its breadcrumb is intact).
        await mount.history.notifyWatchers(watcherIds, {
            eventType: 'deleted',
            actor: user,
            itemName: item.name,
            tagPathId: item.id,
            verifyAncestors: [...(trashedFrom ? await mount.getBreadcrumb(trashedFrom) : []), item],
        });
    }
}

async function propagateACLRemovalRecursively(mount: Mount, pathId: string): Promise<void> {
    const path = await mount.getPath(pathId);
    if (!path) return;
    if (path.acl) {
        await propagateACLChange(path, path.acl, null, null);
    }
    if (isContainerType(path.type)) {
        const children = await mount.listFolderAll(pathId);
        for (const child of children) {
            await propagateACLRemovalRecursively(mount, child.id);
        }
    }
}

async function propagateACLRestoreRecursively(mount: Mount, pathId: string): Promise<void> {
    const children = await mount.listFolderAll(pathId);
    for (const child of children) {
        if (child.acl) {
            await propagateACLChange(child, null, child.acl, null);
        }
        if (isContainerType(child.type)) {
            await propagateACLRestoreRecursively(mount, child.id);
        }
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
