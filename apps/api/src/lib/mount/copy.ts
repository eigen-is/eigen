// Copies a file or folder inside one mount. A folder is created again and walked item by item,
// so a copied Eigen document keeps its type but starts without its old version history. A file is
// saved again from a fresh temp copy, and the copy gets its own search entry and thumbnail. It
// also records where each copy came from. Mount.copyPath calls it, and a copy between mounts has its
// own walk, copyPathAcross.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { storageGone } from '../core';
import { copyThumbnail } from '../shared/thumbnails';
import { writeTempWithHash } from '../storage';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { Mount } from './mount';
import { markContentDirty } from './search-index';

export async function copyPath(
    mount: Mount,
    srcPathId: string,
    destParentId: string,
    name: string,
    actor?: { id: string; email: string },
): Promise<DrivePath> {
    const src = await mount.getActivePath(srcPathId);
    const copiedFrom = {
        sourceOwnerId: mount.history.ownerId,
        sourceMountId: mount.history.mountId,
        sourcePathId: srcPathId,
    };

    if (isContainerType(src.type)) {
        const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
        if (isEigenDoc) await mount.flushContainerDb(srcPathId);
        const newId = await mount.createFolder(destParentId, name, src.type);
        if (actor) {
            mount.history.record({ pathId: newId, eventType: 'copied', actor, details: copiedFrom });
        }
        // A copy that fails part way removes its folder, so each retry does not leave another half-built
        // one. The source is untouched and the folder holds only this copy, so there is nothing to keep.
        try {
            for (const child of await mount.listFolder(srcPathId)) {
                if (isEigenDoc && isVersionsFolder(child)) continue;
                await copyPath(mount, child.id, newId, child.name, actor);
            }
        } catch (e) {
            await mount.deletePath(newId).catch((cleanupErr: unknown) => {
                console.warn(`[copy] Could not remove the failed copy ${newId}:`, cleanupErr);
            });
            throw e;
        }
        // The data.db arrives as plain bytes, so no sync tells search about the new document. It is
        // marked for the reindexer here instead.
        if (isEigenDoc) {
            markContentDirty(mount, newId);
            mount.reindexQueue?.markDirty(newId);
        }
        return mount.getActivePath(newId);
    }

    // readFile reads the freshest copy, such as the staged bytes of an upload the bucket has not
    // acknowledged yet. For a document's data.db, the flush of its container put the latest edits there.
    const tempId = crypto.randomUUID();
    try {
        // The read holds the tree lock shared. On `local` a rename of a folder above it would otherwise
        // make the file read as gone.
        const { size, hash } = await mount.withTreeShared(async () => {
            const srcFile = await mount.readFile(srcPathId);
            if (!srcFile) throw storageGone();
            return writeTempWithHash(mount.getTempPath(tempId), srcFile);
        });
        const newId = await mount.createFileFromTemp(destParentId, name, src.mimeType, size, hash, tempId);
        // The media facts the upload path derives from the bytes travel with them, thumbnail or not.
        // The rest of details stays behind: originalName names the source's own downloads and
        // webdavProps are its client's dead properties.
        const details = {
            ...(src.details?.width !== undefined && { width: src.details.width }),
            ...(src.details?.height !== undefined && { height: src.details.height }),
            ...(src.details?.duration !== undefined && { duration: src.details.duration }),
        };
        const hasDetails = Object.keys(details).length > 0;
        const thumbnail = src.thumbnail ? await copyThumbnail(mount.thumbsDir, src.thumbnail, newId) : null;
        if (thumbnail || hasDetails) {
            await mount.updatePath(newId, { ...(thumbnail && { thumbnail }), ...(hasDetails && { details }) });
        }
        if (actor) {
            mount.history.record({ pathId: newId, eventType: 'copied', actor, details: copiedFrom });
        }
        return await mount.getActivePath(newId);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
