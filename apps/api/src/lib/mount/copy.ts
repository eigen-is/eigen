// The one walk behind every copy of a file or folder, in one mount or to another drive. It lists the
// whole source tree first and writes only after that, so a copy never follows its own output, even when
// its target moves into the source or an opposite copy writes into it meanwhile. Drive.copyPath checks
// that list against the target's limits before the write. A writer does the writing, such as the one
// here that copies inside the mount, or one that uploads into another drive.

import type { DriveContainerType, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { storageGone } from '../core';
import { copyThumbnail } from '../shared/thumbnails';
import { writeTempWithHash } from '../storage';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { Mount } from './mount';
import { markContentDirty } from './search-index';

// A source path with the paths below it that a copy writes, as they were when the copy began.
export type CopyTree = { readonly path: DrivePath; readonly children: readonly CopyTree[] };

// How a copy writes into its target. Each create returns the path it made.
type CopyWriter = {
    createFolder: (parentId: string, name: string, type: DriveContainerType, src: DrivePath) => Promise<DrivePath>;
    copyFile: (parentId: string, name: string, src: DrivePath) => Promise<DrivePath>;
    // Runs once everything inside a copied folder or document has landed.
    folderCopied?: (copy: DrivePath, src: DrivePath) => void;
    // Removes the top folder of a copy that failed part way.
    discard: (pathId: string) => Promise<void>;
};

// A copied Eigen document keeps its type but leaves its version history behind, so its versions/ is
// not listed, and the copy starts with a clean history.
export async function listCopy(mount: Mount, src: DrivePath): Promise<CopyTree> {
    if (!isContainerType(src.type)) return { path: src, children: [] };
    const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
    // A document's open database is written to storage first, so the copy gets its latest edits.
    if (isEigenDoc) await mount.flushContainerDb(src.id);
    const children: CopyTree[] = [];
    for (const child of await mount.listFolder(src.id)) {
        if (isEigenDoc && isVersionsFolder(child)) continue;
        children.push(await listCopy(mount, child));
    }
    return { path: src, children };
}

// The bytes a copy writes. Each document inside counts without its version history.
export function copySize(tree: CopyTree): number {
    if (!isContainerType(tree.path.type)) return tree.path.size;
    return tree.children.reduce((size, child) => size + copySize(child), 0);
}

export async function writeCopy(
    tree: CopyTree,
    destParentId: string,
    name: string,
    writer: CopyWriter,
): Promise<DrivePath> {
    // The walk creates the top folder before anything else, so it is the first one here.
    const createdFolderIds: string[] = [];
    try {
        return await writeTree(tree, destParentId, name, writer, createdFolderIds);
    } catch (e) {
        // A copy that fails part way removes its folder, so each retry does not leave another half-built
        // one. The source is untouched and the folder holds only this copy, so there is nothing to keep.
        const topId = createdFolderIds[0];
        if (topId) {
            await writer.discard(topId).catch((cleanupErr: unknown) => {
                console.warn(`[copy] Could not remove the failed copy ${topId}:`, cleanupErr);
            });
        }
        throw e;
    }
}

// The copy inside one mount. A file is saved again from a fresh temp copy, and gets its own search entry
// and thumbnail. Each copied path records where it came from.
export async function copyPath(
    mount: Mount,
    tree: CopyTree,
    destParentId: string,
    name: string,
    actor?: { id: string; email: string },
): Promise<DrivePath> {
    const recordCopied = (pathId: string, src: DrivePath): void => {
        if (!actor) return;
        const details = {
            sourceOwnerId: mount.history.ownerId,
            sourceMountId: mount.history.mountId,
            sourcePathId: src.id,
        };
        mount.history.record({ pathId, eventType: 'copied', actor, details });
    };
    const copied = await writeCopy(tree, destParentId, name, {
        createFolder: async (parentId, folderName, type, src) => {
            const newId = await mount.createFolder(parentId, folderName, type);
            recordCopied(newId, src);
            return mount.getActivePath(newId);
        },
        copyFile: async (parentId, fileName, src) => {
            const copy = await copyFile(mount, src.id, parentId, fileName);
            recordCopied(copy.id, src);
            return copy;
        },
        // The data.db arrives as plain bytes, so no sync tells search about the new document. It is
        // marked for the reindexer here instead.
        folderCopied: (copy, src) => {
            if (src.type === DRIVE_TYPE_FOLDER) return;
            markContentDirty(mount, copy.id);
            mount.reindexQueue?.markDirty(copy.id);
        },
        // No trash and no SSE: Drive.copyPath announces a copy in one mount only once it is done.
        discard: (pathId) => mount.deletePath(pathId),
    });
    // Read again, so the top folder's size counts what landed in it.
    return mount.getActivePath(copied.id);
}

async function writeTree(
    tree: CopyTree,
    parentId: string,
    name: string,
    writer: CopyWriter,
    createdFolderIds: string[],
): Promise<DrivePath> {
    const src = tree.path;
    if (!isContainerType(src.type)) return writer.copyFile(parentId, name, src);
    const copy = await writer.createFolder(parentId, name, src.type, src);
    createdFolderIds.push(copy.id);
    for (const child of tree.children) {
        await writeTree(child, copy.id, child.path.name, writer, createdFolderIds);
    }
    writer.folderCopied?.(copy, src);
    return copy;
}

async function copyFile(mount: Mount, srcPathId: string, destParentId: string, name: string): Promise<DrivePath> {
    // The row is read again, as the listing can be a while ago. A thumbnail made since then comes along.
    const src = await mount.getActivePath(srcPathId);
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
        return await mount.getActivePath(newId);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
