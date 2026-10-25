// Puts a document back to one of its saved versions. Drive.restoreContainer calls it when a user
// picks a version in the history panel. It first saves the current state as a version of its own. An
// open document then takes the old state in place, so connected editors follow without a reload.

import { randomUUID } from 'node:crypto';
import { isCurrentSheetsSnapshot } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_SHEETS, isCollabType } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readYjsStateFromFile } from '../collab/yjs-loader';
import { ApiError } from '../core';
import { readSheetsSnapshotJson } from '../document/sheets';
import type { Drive } from '../drive';
import type { Mount } from '../mount/mount';
import type { RetentionPolicy } from './retention';
import { DEFAULT_RETENTION } from './retention';
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

    // The version is copied to a temp file before the current state is saved. Saving prunes old
    // versions, and it could prune the very version this restores. The copy reads the raw bytes,
    // because Mount.openDatabase would migrate and cache a version that must never change. Each step
    // takes the container lock on its own, and no lock is held from one step to the next. Every
    // restore gets its own temp file, so one restore's cleanup can't delete the file another still reads.
    const tempId = randomUUID();
    const tempPath = await mount.downloadToTemp(target.id, tempId);
    try {
        // Read before the pre-restore snapshot, so a version that cannot be restored changes nothing.
        const state = isCollabType(container.type)
            ? readYjsStateFromFile(tempPath, { label: `restore:${target.name}` })
            : null;
        if (state && container.type === DRIVE_TYPE_SHEETS) {
            // A version in an older sheet format would turn every open editor read-only.
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
        // A 410 means data.db is gone, after the temp and staged copies were checked too. Then there
        // are no bytes to save first and no live document to update.
        const gone = await mount.snapshotContainerDataDb(container.id, policy).then(
            () => false,
            (error: unknown) => {
                if (!(error instanceof ApiError && error.status === 410)) throw error;
                return true;
            },
        );
        if (!gone && state) {
            // A collab document, such as a doc or a sheet, takes the old state in place. Connected
            // editors follow without a reload.
            await restoreYjsContainer(drive, mount, container.id, state);
        } else {
            // A chat, or a gone data.db, gets the bytes of the version written over data.db.
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
    // getCollabDocument opens the document when nobody has it open. The old state goes in as one
    // change, which the document saves to data.db and sends to every connected editor. An editor
    // that is offline catches up when it next syncs. Whether the document was open is read first,
    // because getCollabDocument opens it.
    const wasOpen = drive.hasCollabDocument(mount.id, containerId);
    const collabDoc = await drive.getCollabDocument(mount.id, containerId);
    collabDoc.applySnapshotState(snapshotState);

    // A document this restore opened, with nobody connected, closes again so it doesn't leak. One
    // that was already open stays with its editors. No final version is saved, because the restore
    // saved the state before it already.
    if (!wasOpen && collabDoc.connectionCount === 0) {
        await drive.closeCollabDocument(mount.id, containerId, { skipFinalSnapshot: true });
    }
}
