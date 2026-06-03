import { type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { ApiError } from '../core';
import type Drive from '../drive/drive';
import type { Mount } from '../mount/mount';
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention';

export async function restoreContainer(
    drive: Drive,
    mount: Mount,
    container: DrivePath,
    snapshotName: string,
    policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<void> {
    await mount.withPathLock(container.id, async () => {
        // Look up the target up front so the pre-restore snapshot's pruning
        // can preserve it — otherwise the new pre-restore would push the
        // target out of its retention slot and the restore step 404s.
        const versions = await mount.getChildByName(container.id, 'versions');
        if (!versions) throw new ApiError(404, 'No versions folder');
        const target = await mount.getChildByName(versions.id, snapshotName);
        if (!target) throw new ApiError(404, `Snapshot ${snapshotName} not found`);

        // 1. Pre-restore snapshot so the operation is reversible.
        await mount.snapshotContainerDataDb(container.id, policy, target.id);

        // Every Yjs container (doc/sheets/slides/stickies) restores by replaying
        // the snapshot's state into the live Y.Doc inside a single transaction;
        // the resulting update flows through CollabDocument's normal broadcast
        // path so connected editors converge live. Chat has no Y.Doc — close
        // cached managedDbs and swap data.db on storage.
        if (isCollabType(container.type)) {
            await restoreYjsContainer(drive, mount, container.id, target);
        } else {
            await evictContainer(mount, container.id);
            await mount.restoreContainerDataDb(container.id, snapshotName);
        }
    });
}

// Close the chat container's cached data.db before restoreContainerDataDb swaps
// the file on storage. Chat is the only caller (it's the non-Yjs branch): it has
// no collab singleton (getCollabDocument rejects non-collab types) and no sidecar
// DBs, so closing data.db is all that needs evicting. Caller MUST hold
// withPathLock to serialise concurrent restore/save.
//
// skipFinalSnapshot: the pre-restore snapshot already ran; a close-time snapshot
// would race the imminent data.db delete + replace and could prune the target.
async function evictContainer(mount: Mount, containerId: string): Promise<void> {
    const dataDb = await mount.getChildByName(containerId, 'data.db');
    if (dataDb) await mount.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
}

async function restoreYjsContainer(
    drive: Drive,
    mount: Mount,
    containerId: string,
    snapshotPath: DrivePath,
): Promise<void> {
    // Read the snapshot's Yjs state from a local copy (S3 backends download it
    // to a temp file) — no migrations, no cache pollution in Mount.documentDbs.
    const snapshotState = await mount.withLocalCopy(snapshotPath.id, (localPath) =>
        readYjsStateFromFile(localPath, `restore:${snapshotPath.name}`),
    );

    // getCollabDocument creates the singleton if no one is connected.
    // applySnapshotState runs the surgery inside one transaction; the resulting
    // update fires CollabDocument's existing 'update' handler → DbProvider
    // persists to data.db AND every connected WebSocket receives the diff.
    // Disconnected sessions catch up via the next sync handshake.
    // Did a live editor session already hold this doc open, or are we opening it
    // purely for the surgery? Checked BEFORE getCollabDocument creates it.
    const wasOpen = drive.hasCollabDocument(mount.id, containerId);
    const collabDoc = await drive.getCollabDocument(mount.id, containerId);
    collabDoc.applySnapshotState(snapshotState);

    // A restore from the file list opens the doc with no subscriber; close it so
    // it doesn't leak. If it was already open (live editor, import/export), that
    // owner manages its lifecycle — closing would yank it out from under them.
    // (subscribe doesn't take the path lock, so a client connecting during this
    // close is simply bounced and reconnects to the restored state.)
    if (!wasOpen && collabDoc.connectionCount === 0) {
        await drive.closeCollabDocument(mount.id, containerId);
    }
}
