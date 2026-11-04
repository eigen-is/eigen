// The one walk behind every copy of a file or folder, in one mount or to another drive. It lists the
// whole source tree first and writes only after that, so a copy never follows its own output, even when
// its target moves into the source or an opposite copy writes into it meanwhile. Drive.copyPath may
// leave parts out of that list, such as those a document's state no longer names, and checks it against
// the target's limits before the write. A writer does the writing, such as the one here that copies
// inside the mount, or one that uploads into another drive.

import type { DriveContainerType, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { storageGone } from '../core';
import { copyThumbnail } from '../shared/thumbnails';
import { writeTempWithHash } from '../storage';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { Mount } from './mount';
import { markContentDirty } from './search-index';

// A source path with the paths below it that a copy writes, as they were when the copy began. A file whose bytes were
// read while the tree was listed, such as the data.db a document's filter read, keeps them in a temp copy, and the copy
// writes those bytes. A document whose filter left threads behind says so, so its copy cuts their comment rows.
export type CopyTree = {
    readonly path: DrivePath;
    readonly children: readonly CopyTree[];
    readonly read?: { readonly tempId: string; readonly file: BunFile };
    readonly leftThreads?: boolean;
};

// Removes the top folder of a copy that failed part way. createdIds holds every path the copy made.
export type DiscardCopy = (pathId: string, createdIds: ReadonlySet<string>) => Promise<void>;

// What the drive does once a copied document has landed, such as cutting its comment index to the threads it took.
// A throw fails the copy, which then removes its folder.
export type DocumentCopied = (copy: DrivePath, src: CopyTree) => Promise<void>;

// How a copy writes into its target. Each create returns the path it made.
type CopyWriter = {
    createFolder: (parentId: string, name: string, type: DriveContainerType, src: DrivePath) => Promise<DrivePath>;
    // `read` holds the bytes the listing read, when it read them.
    copyFile: (parentId: string, name: string, src: DrivePath, read?: BunFile) => Promise<DrivePath>;
    // Runs once everything inside a copied folder or document has landed.
    folderCopied?: (copy: DrivePath, src: CopyTree) => Promise<void>;
    discard: DiscardCopy;
};

// A copied Eigen document keeps its type but leaves its version history behind, so its versions/ is
// not listed, and the copy starts with a clean history.
export async function listCopy(mount: Mount, src: DrivePath): Promise<CopyTree> {
    if (!isContainerType(src.type)) return { path: src, children: [] };
    const isEigenDoc = src.type !== DRIVE_TYPE_FOLDER;
    // A document's open databases are written to storage first, so the copy gets its latest edits.
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
    const createdIds = new Set<string>();
    try {
        return await writeTree(tree, destParentId, name, writer, createdIds);
    } catch (e) {
        // A copy that fails part way removes its folder, so each retry does not leave another half-built
        // one. The source is untouched, so nothing the copy wrote needs keeping.
        const [topId] = createdIds;
        if (topId) {
            await writer.discard(topId, createdIds).catch((cleanupErr: unknown) => {
                console.warn(`[copy] Could not remove the failed copy ${topId}:`, cleanupErr);
            });
        }
        throw e;
    }
}

// The copy inside one mount. A file is saved again from a fresh temp copy, and gets its own search entry
// and thumbnail. Each copied path records where it came from. The caller passes the cleanup of a copy that
// fails, because whether it may delete for good or must trash is a drive's decision.
export async function copyPath(
    mount: Mount,
    tree: CopyTree,
    destParentId: string,
    name: string,
    discard: DiscardCopy,
    actor?: { id: string; email: string },
    documentCopied?: DocumentCopied,
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
        copyFile: async (parentId, fileName, listed, read) => {
            // The row is read again, as the listing can be a while ago. A thumbnail made since then comes
            // along, and a file trashed since then stops the copy.
            const src = await mount.getActivePath(listed.id);
            // readFile reads the freshest copy, such as the staged bytes of an upload the bucket has not
            // acknowledged yet. A document's data.db that the filter did not read holds what the flush of its
            // container put there.
            const tempId = crypto.randomUUID();
            try {
                // The read holds the tree lock shared. On `local` a rename of a folder above it would otherwise
                // make the file read as gone.
                const { size, hash } = await mount.withTreeShared(async () => {
                    const srcFile = read ?? (await mount.readFile(src.id));
                    if (!srcFile) throw storageGone();
                    return writeTempWithHash(mount.getTempPath(tempId), srcFile);
                });
                const newId = await mount.createFileFromTemp(parentId, fileName, src.mimeType, size, hash, tempId);
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
                recordCopied(newId, src);
                return await mount.getActivePath(newId);
            } finally {
                await mount.cleanupTemp(tempId);
            }
        },
        // The data.db arrives as plain bytes, so no sync tells search about the new document. It is
        // marked for the reindexer here instead.
        folderCopied: async (copy, src) => {
            if (src.path.type === DRIVE_TYPE_FOLDER) return;
            markContentDirty(mount, copy.id);
            mount.reindexQueue?.markDirty(copy.id);
            await documentCopied?.(copy, src);
        },
        discard,
    });
    // Read again, so the top folder's size counts what landed in it.
    return mount.getActivePath(copied.id);
}

async function writeTree(
    tree: CopyTree,
    parentId: string,
    name: string,
    writer: CopyWriter,
    createdIds: Set<string>,
): Promise<DrivePath> {
    const src = tree.path;
    if (!isContainerType(src.type)) {
        const copy = await writer.copyFile(parentId, name, src, tree.read?.file);
        createdIds.add(copy.id);
        return copy;
    }
    const copy = await writer.createFolder(parentId, name, src.type, src);
    createdIds.add(copy.id);
    for (const child of tree.children) {
        await writeTree(child, copy.id, child.path.name, writer, createdIds);
    }
    await writer.folderCopied?.(copy, tree);
    return copy;
}
