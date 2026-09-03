import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import type { User } from '../user';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { DriveLike } from './get-drive';

// Recursive copy across mount and/or owner boundaries. Re-uploads each file into
// the target via downloadFile + createFileFromData; recreates folders/containers
// with createFolder (typed). Containers are valid after a byte copy because their
// internal children are referenced by name, not pathId.
export async function copyPathAcross(
    source: DriveLike,
    srcMountId: string,
    srcPathId: string,
    target: DriveLike,
    destMountId: string,
    destParentId: string,
    name: string,
    user: User,
): Promise<DrivePath> {
    const src = await source.getPath(srcMountId, srcPathId);
    if (!src) throw new ApiError(404, 'Source not found');

    if (isContainerType(src.type)) {
        const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
        if (isEigenDoc) await source.flushContainerDb(srcMountId, srcPathId);
        const containerType = isEigenDoc ? src.type : DRIVE_TYPE_FOLDER;
        const created = await target.createFolder(destMountId, destParentId, name, user, containerType);

        const children = await source.getFolderContents(srcMountId, srcPathId);
        for (const child of children) {
            if (isEigenDoc && isVersionsFolder(child)) continue;
            await copyPathAcross(source, srcMountId, child.id, target, destMountId, created.id, child.name, user);
        }
        return created;
    }

    const file = await source.downloadFile(srcMountId, srcPathId);
    if (!file) throw new ApiError(404, 'Source file data not found');
    return target.createFileFromData(destMountId, destParentId, name, src.mimeType, file, user);
}
