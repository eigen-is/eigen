import { randomUUID } from 'node:crypto';
import { type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { ApiError } from '../core';
import type Drive from '../drive/drive';
import { SOURCE_MISSING_ON_STORAGE } from '../mount/copy';
import type { Mount } from '../mount/mount';
import { DEFAULT_RETENTION, type RetentionPolicy } from './retention';
import { VERSIONS_FOLDER_NAME } from './versions-folder';

export async function restoreContainer(
    drive: Drive,
    mount: Mount,
    container: DrivePath,
    snapshotName: string,
    policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<void> {
    const versions = await mount.getChildByName(container.id, VERSIONS_FOLDER_NAME);
    if (!versions) throw new ApiError(404, 'No versions folder');
    const target = await mount.getChildByName(versions.id, snapshotName);
    if (!target) throw new ApiError(404, `Snapshot ${snapshotName} not found`);

    // Grab the target into the OS temp dir BEFORE the pre-restore snapshot runs — that
    // snapshot prunes old versions and could otherwise drop the very snapshot we're
    // restoring. Read raw (downloadToTemp works on every backend); opening via
    // Mount.openDatabase would migrate and cache an immutable archive. Every step
    // self-serializes on the container lock; we never hold a lock across them.
    // The temp id is unique per invocation: concurrent restores of the same snapshot
    // must not share a temp file (one's cleanup would delete it under the other's read).
    const tempId = randomUUID();
    const tempPath = await mount.downloadToTemp(target.id, tempId);
    try {
        // A gone data.db has no bytes to preserve and no live Y.Doc to converge. s3 answers 410 once the temp
        // and staged copy were checked; local and local-key answer copyPath's own 404.
        const gone = await mount.snapshotContainerDataDb(container.id, policy).then(
            () => false,
            (error: unknown) => {
                const missing =
                    error instanceof ApiError &&
                    (error.status === 410 || (error.status === 404 && error.message === SOURCE_MISSING_ON_STORAGE));
                if (!missing) throw error;
                return true;
            },
        );
        if (!gone && isCollabType(container.type)) {
            // Yjs (doc/sheets/slides/stickies): replay the snapshot's state into the
            // live Y.Doc so connected editors converge with no reload.
            const state = readYjsStateFromFile(tempPath, { label: `restore:${target.name}` });
            await restoreYjsContainer(drive, mount, container.id, state);
        } else {
            // Chat, or a gone data.db: overwrite data.db's bytes with the snapshot's.
            await mount.replaceContainerDataDb(container.id, tempPath);
        }
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

async function restoreYjsContainer(
    drive: Drive,
    mount: Mount,
    containerId: string,
    snapshotState: Uint8Array,
): Promise<void> {
    // getCollabDocument creates the singleton if no one is connected.
    // applySnapshotState runs the surgery inside one transaction; the resulting
    // update fires CollabDocument's existing 'update' handler → DbProvider persists
    // to data.db AND every connected WebSocket receives the diff. Disconnected
    // sessions catch up via the next sync handshake. Check whether an editor session
    // already held the doc open BEFORE getCollabDocument creates it.
    const wasOpen = drive.hasCollabDocument(mount.id, containerId);
    const collabDoc = await drive.getCollabDocument(mount.id, containerId);
    collabDoc.applySnapshotState(snapshotState);

    // A restore from the file list opens the doc with no subscriber; close it so it
    // doesn't leak. If it was already open (live editor), that owner manages its
    // lifecycle. skipFinalSnapshot: we don't snapshot a doc opened only to run
    // surgery — the pre-restore snapshot already captured the prior state.
    if (!wasOpen && collabDoc.connectionCount === 0) {
        await drive.closeCollabDocument(mount.id, containerId, { skipFinalSnapshot: true });
    }
}
