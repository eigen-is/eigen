// Copies a file or folder to another mount or to another owner's drive, through the Drive methods both
// sides offer. Each file is downloaded and uploaded again, and each folder or Eigen document is created
// again with its type, without the document's version history. A document's insides refer to each other
// by name, not by path id, so the byte copy is a valid document. The copy route calls it for every copy
// that leaves its mount.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { storageGone } from '../core';
import type { User } from '../user';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { DriveLike } from './get-drive';

export async function copyPathAcross(
    source: DriveLike,
    src: DrivePath,
    target: DriveLike,
    destMountId: string,
    destParentId: string,
    name: string,
    user: User,
): Promise<DrivePath> {
    if (!isContainerType(src.type)) {
        return copyFileAcross(source, src, target, destMountId, destParentId, name, user);
    }
    // A document's open database is written to storage first, so the copy gets its latest edits.
    if (src.type !== DRIVE_TYPE_FOLDER) await source.flushContainerDb(src.mountId, src.id);
    const created = await target.createFolder(destMountId, destParentId, name, user, src.type);
    // A copy that fails part way moves its folder to the trash, so each retry does not leave another
    // half-built one. The source is untouched and the folder holds only this copy, so there is nothing
    // to keep. The trash is the only delete a drive offers here, and it tells the tabs that saw the
    // folder appear.
    try {
        await copyChildrenAcross(source, src, target, destMountId, created.id, user);
    } catch (e) {
        await target.deletePath(destMountId, created.id, user).catch((cleanupErr: unknown) => {
            console.warn(`[copy] Could not trash the failed copy ${created.id}:`, cleanupErr);
        });
        throw e;
    }
    return created;
}

// The walk below the top folder. It cleans up nothing itself: the trash of the top folder takes it all.
async function copyChildrenAcross(
    source: DriveLike,
    folder: DrivePath,
    target: DriveLike,
    destMountId: string,
    destFolderId: string,
    user: User,
): Promise<void> {
    const isEigenDoc = folder.type !== DRIVE_TYPE_FOLDER;
    for (const child of await source.getFolderContents(folder.mountId, folder.id)) {
        if (isEigenDoc && isVersionsFolder(child)) continue;
        if (!isContainerType(child.type)) {
            await copyFileAcross(source, child, target, destMountId, destFolderId, child.name, user);
            continue;
        }
        if (child.type !== DRIVE_TYPE_FOLDER) await source.flushContainerDb(child.mountId, child.id);
        const created = await target.createFolder(destMountId, destFolderId, child.name, user, child.type);
        await copyChildrenAcross(source, child, target, destMountId, created.id, user);
    }
}

async function copyFileAcross(
    source: DriveLike,
    src: DrivePath,
    target: DriveLike,
    destMountId: string,
    destParentId: string,
    name: string,
    user: User,
): Promise<DrivePath> {
    const file = await source.downloadFile(src.mountId, src.id);
    if (!file) throw storageGone();
    return target.createFileFromData(destMountId, destParentId, name, src.mimeType, file, user);
}
