// Copies a file or folder to another mount or to another owner's drive, through the Drive methods both
// sides offer. Each file is downloaded and uploaded again, and each folder or Eigen document is created
// again with its type, without the document's version history. A document's insides refer to each other
// by name, not by path id, so the byte copy is a valid document. The copy route calls it for every copy
// that leaves its mount, and sizes every copy with copySize first.

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
    // The walk creates the top folder before anything else, so it is the first one here.
    const createdFolderIds: string[] = [];
    try {
        return await copyTreeAcross(source, src, target, destMountId, destParentId, name, user, createdFolderIds);
    } catch (e) {
        // A copy that fails part way moves its folder to the trash, so each retry does not leave another
        // half-built one. The source is untouched and the folder holds only this copy, so there is nothing
        // to keep. The trash is the only delete a drive offers here, and it tells the tabs that saw the
        // folder appear.
        const topId = createdFolderIds[0];
        if (topId) {
            await target.deletePath(destMountId, topId, user).catch((cleanupErr: unknown) => {
                console.warn(`[copy] Could not trash the failed copy ${topId}:`, cleanupErr);
            });
        }
        throw e;
    }
}

async function copyTreeAcross(
    source: DriveLike,
    src: DrivePath,
    target: DriveLike,
    destMountId: string,
    destParentId: string,
    name: string,
    user: User,
    createdFolderIds: string[],
): Promise<DrivePath> {
    if (isContainerType(src.type)) {
        const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
        // A document's open database is written to storage first, so the copy gets its latest edits.
        if (isEigenDoc) await source.flushContainerDb(src.mountId, src.id);
        const created = await target.createFolder(destMountId, destParentId, name, user, src.type);
        createdFolderIds.push(created.id);
        for (const child of await source.getFolderContents(src.mountId, src.id)) {
            if (isEigenDoc && isVersionsFolder(child)) continue;
            await copyTreeAcross(source, child, target, destMountId, created.id, child.name, user, createdFolderIds);
        }
        return created;
    }

    const file = await source.downloadFile(src.mountId, src.id);
    if (!file) throw storageGone();
    return target.createFileFromData(destMountId, destParentId, name, src.mimeType, file, user);
}

// The bytes a copy of src writes, in one mount or across. That is its size without the version history
// of each document inside, which every copy leaves behind.
export async function copySize(drive: DriveLike, src: DrivePath): Promise<number> {
    if (!isContainerType(src.type)) return src.size;
    const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
    let size = 0;
    for (const child of await drive.getFolderContents(src.mountId, src.id)) {
        if (isEigenDoc && isVersionsFolder(child)) continue;
        size += await copySize(drive, child);
    }
    return size;
}
