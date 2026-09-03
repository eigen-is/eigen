import { type DrivePath, isCollabType, isContainerType } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { Mount } from '../mount';
import type { User } from '../user';
import { propagateSharedPathChange } from './acl-propagation';
import type Drive from './drive';
import { broadcastFileHistoryUpdated } from './sse-events';

// Trash lifecycle bodies. Drive's deletePath/restorePath/permanentlyDelete keep their
// liveness checks and delegate here (the versioning/restore.ts pattern).

export async function deletePath(drive: Drive, mount: Mount, item: DrivePath, user?: User): Promise<void> {
    // Capture BEFORE trashPath re-parents the item to the mount root — the
    // post-trash breadcrumb would lose the old folder's ACL and silently skip
    // exactly the folder-watchers this event is for.
    const preTrashChain = user ? await mount.getBreadcrumb(item.id) : [];

    // Effective members of the OLD location — captured before trashPath re-parents the item to
    // root and strips its share, so the post-record history broadcast still reaches everyone who
    // could see it (getEffectiveMembers walks the current chain, which is gone after the trash).
    const members = user ? await drive.getEffectiveMembers(mount.id, item.id) : [];

    // Close collab docs BEFORE setting trashedAt (they use listFolderAll internally)
    if (isContainerType(item.type)) {
        await closeCollabDocumentsRecursively(drive, mount, item.id);
        await propagateACLRemovalRecursively(mount, item.id, user);
    } else if (item.acl) {
        await propagateSharedPathChange(item, item.acl, null, user ?? null);
    }

    const trashedItem = await mount.trashPath(item.id);
    drive.emit(SSEventType.DRIVE_PATH_TRASHED, trashedItem, item.parentId ?? undefined);
    if (user) {
        mount.history.record({ pathId: item.id, eventType: 'trashed', actor: user });
        // path: pre-trash snapshot — trashedAt is still null so the fan-out guard passes
        await mount.history.fanOut({
            eventType: 'trashed',
            actor: user,
            path: item,
            chainRootIds: [item.parentId],
            verifyAncestors: preTrashChain,
        });
        // Live-refresh open Activity panels for the owner + the pre-trash members (drive.emit is
        // owner-home only). Fire-and-forget, mirroring recordFileEvent.
        broadcastFileHistoryUpdated(item.ownerId, item, members).catch(() => {});
    }
}

export async function restorePath(drive: Drive, mount: Mount, pathId: string, user?: User): Promise<void> {
    const restoredItem = await mount.restorePath(pathId);

    // Re-propagate ACL. old=new ACL → empty added-diff: restore re-shares (naming the actor) without re-emailing.
    if (restoredItem.acl) {
        await propagateSharedPathChange(restoredItem, restoredItem.acl, restoredItem.acl, user ?? null);
    }
    // For containers, re-propagate for descendants with ACL
    if (isContainerType(restoredItem.type)) {
        await propagateACLRestoreRecursively(mount, restoredItem.id, user);
    }

    drive.emit(SSEventType.DRIVE_PATH_RESTORED, restoredItem);
    // recordFileEvent re-fetches the path, so it sees the post-restore row
    // (trashedAt cleared, original parentId) — the chain it walks is the restored one
    if (user) await drive.recordFileEvent(mount.id, pathId, user, { eventType: 'restored' });
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

    if (isContainerType(item.type)) {
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
            pathType: item.type,
            tagPathId: item.id,
            verifyAncestors: [...(trashedFrom ? await mount.getBreadcrumb(trashedFrom) : []), item],
        });
    }
}

async function propagateACLRemovalRecursively(mount: Mount, pathId: string, user?: User): Promise<void> {
    const path = await mount.getPath(pathId);
    if (!path) return;
    if (path.acl) {
        await propagateSharedPathChange(path, path.acl, null, user ?? null);
    }
    if (isContainerType(path.type)) {
        const children = await mount.listFolderAll(pathId);
        for (const child of children) {
            await propagateACLRemovalRecursively(mount, child.id, user);
        }
    }
}

async function propagateACLRestoreRecursively(mount: Mount, pathId: string, user?: User): Promise<void> {
    const children = await mount.listFolderAll(pathId);
    for (const child of children) {
        if (child.acl) {
            // old=new ACL → empty added-diff so restore re-shares without re-emailing (see restorePath).
            await propagateSharedPathChange(child, child.acl, child.acl, user ?? null);
        }
        if (isContainerType(child.type)) {
            await propagateACLRestoreRecursively(mount, child.id, user);
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
