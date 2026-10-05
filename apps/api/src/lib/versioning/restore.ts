import { randomUUID } from 'node:crypto';
import { isCurrentSheetsSnapshot } from '@workspace/lib/sheets';
import { DRIVE_TYPE_SHEETS, type DrivePath, isCollabType } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { ApiError } from '../core';
import { readSheetsSnapshotJson } from '../document/sheets';
import type Drive from '../drive/drive';
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

    // Grab the target into a mount temp file BEFORE the pre-restore snapshot runs — that
    // snapshot prunes old versions and could otherwise drop the very snapshot we're
    // restoring. Read raw (downloadToTemp works on every backend); opening via
    // Mount.openDatabase would migrate and cache an immutable archive. Every step
    // self-serializes on the container lock; we never hold a lock across them.
    // The temp id is unique per invocation: concurrent restores of the same snapshot
    // must not share a temp file (one's cleanup would delete it under the other's read).
    const tempId = randomUUID();
    const tempPath = await mount.downloadToTemp(target.id, tempId);
    try {
        // Read before the pre-restore snapshot, so a version that cannot be restored changes nothing.
        const state = isCollabType(container.type)
            ? readYjsStateFromFile(tempPath, { label: `restore:${target.name}` })
            : null;
        if (state && container.type === DRIVE_TYPE_SHEETS) {
            // A snapshot in an older encoding would lock every open editor read-only (SHEETS.md).
            const doc = new Y.Doc();
            try {
                Y.applyUpdate(doc, state);
                const snapshot = readSheetsSnapshotJson(doc);
                if (snapshot && !isCurrentSheetsSnapshot(snapshot)) {
                    throw new ApiError(409, 'This version was saved in an older sheet format and cannot be restored');
                }
            } finally {
                doc.destroy();
            }
        }
        // A gone data.db (410, once the temp and staged copy were checked) has no bytes to preserve and no
        // live Y.Doc to converge.
        const gone = await mount.snapshotContainerDataDb(container.id, policy).then(
            () => false,
            (error: unknown) => {
                if (!(error instanceof ApiError && error.status === 410)) throw error;
                return true;
            },
        );
        if (!gone && state) {
            // Yjs (doc/sheets/slides/stickies): replay the snapshot's state into the
            // live Y.Doc so connected editors converge with no reload.
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
