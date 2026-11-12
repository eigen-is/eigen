// The one walk behind every copy of a file or folder, into the same mount or into another mount or drive.
// It lists the whole source tree first and writes only after that, so a copy never follows its own output,
// even when its target moves into the source or an opposite copy writes into it meanwhile. Drive checks
// that list against the target's limits, and then the target's mount writes it, reading each file through
// the source's mount.

import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { storageGone } from '../core';
import { copyThumbnail } from '../shared/thumbnails';
import { writeTempWithHash } from '../storage';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { Mount } from './mount';

// A source path with the paths below it that a copy writes, as they were when the copy began.
export type CopyTree = { readonly path: DrivePath; readonly children: readonly CopyTree[] };

// What a copy wrote: its top path, every path it made, and each document among them that is not a part of another.
export type Copied = {
    readonly path: DrivePath;
    readonly createdIds: ReadonlySet<string>;
    readonly documentIds: readonly string[];
};

// Removes the top folder of a copy that failed part way. createdIds holds every path the copy made.
export type DiscardCopy = (pathId: string, createdIds: ReadonlySet<string>) => Promise<void>;

type Actor = { id: string; email: string };

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

// Writes a tree listed in `source` into `mount`, which is the same mount for a copy that stays in it. The caller
// passes the cleanup of a failed copy, because whether it may delete for good or must trash is a drive's decision.
export async function copyPath(
    mount: Mount,
    source: Mount,
    tree: CopyTree,
    destParentId: string,
    name: string,
    discard: DiscardCopy,
    actor: Actor,
): Promise<Copied> {
    // The walk creates the top folder before anything else, so it is the first one here.
    const createdIds = new Set<string>();
    const documentIds: string[] = [];
    try {
        const topId = await copyTree(mount, source, tree, destParentId, name, actor, createdIds, documentIds);
        // Read once everything landed, so the top folder's size counts it.
        return { path: await mount.getActivePath(topId), createdIds, documentIds };
    } catch (e) {
        // A copy that fails part way removes its folder, so each retry does not leave another half-built
        // one. The source is untouched, so nothing the copy wrote needs keeping.
        const [topId] = createdIds;
        if (topId) {
            await discard(topId, createdIds).catch((cleanupErr: unknown) => {
                console.warn(`[copy] Could not remove the failed copy ${topId}:`, cleanupErr);
            });
        }
        throw e;
    }
}

async function copyTree(
    mount: Mount,
    source: Mount,
    tree: CopyTree,
    parentId: string,
    name: string,
    actor: Actor,
    createdIds: Set<string>,
    // Null inside a document: a thread in it is one of its parts.
    documentIds: string[] | null,
): Promise<string> {
    const listed = tree.path;
    const isEigenDoc = isContainerType(listed.type) && listed.type !== DRIVE_TYPE_FOLDER;
    const copyId = isContainerType(listed.type)
        ? await mount.createFolder(parentId, name, listed.type)
        : await copyFile(mount, source, listed, parentId, name);
    createdIds.add(copyId);
    if (isEigenDoc) documentIds?.push(copyId);
    const details = {
        sourceOwnerId: source.history.ownerId,
        sourceMountId: source.history.mountId,
        sourcePathId: listed.id,
    };
    mount.history.record({ pathId: copyId, eventType: 'copied', actor, details });
    const below = isEigenDoc ? null : documentIds;
    for (const child of tree.children) {
        await copyTree(mount, source, child, copyId, child.path.name, actor, createdIds, below);
    }
    // A document's data.db arrives as plain bytes, so no sync tells search about the new document. It is
    // marked for the reindexer once everything inside has landed.
    if (isEigenDoc) mount.markContentDirty(copyId);
    return copyId;
}

// Each file is saved again from a fresh temp copy of its bytes.
async function copyFile(
    mount: Mount,
    source: Mount,
    listed: DrivePath,
    parentId: string,
    name: string,
): Promise<string> {
    // The row is read again, as the listing can be a while ago. A thumbnail made since then comes
    // along, and a file trashed since then stops the copy.
    const src = await source.getActivePath(listed.id);
    // readFile reads the freshest copy, such as the staged bytes of an upload the bucket has not
    // acknowledged yet. For a document's databases, the flush of its container put the latest writes there.
    const tempId = crypto.randomUUID();
    try {
        // The read holds the source's tree lock shared. On `local` a rename of a folder above it would
        // otherwise make the file read as gone.
        const { size, hash } = await source.withTreeShared(async () => {
            const srcFile = await source.readFile(src.id);
            if (!srcFile) throw storageGone();
            return writeTempWithHash(mount.getTempPath(tempId), srcFile);
        });
        const copyId = await mount.createFileFromTemp(parentId, name, src.mimeType, size, hash, tempId);
        // Only the media facts derived from the bytes travel with them. originalName and webdavProps
        // describe the source's own downloads and client, so they stay behind.
        const details = {
            ...(src.details?.width !== undefined && { width: src.details.width }),
            ...(src.details?.height !== undefined && { height: src.details.height }),
            ...(src.details?.duration !== undefined && { duration: src.details.duration }),
        };
        const hasDetails = Object.keys(details).length > 0;
        const thumbnail = src.thumbnail
            ? await copyThumbnail(source.thumbsDir, src.thumbnail, mount.thumbsDir, copyId)
            : null;
        if (thumbnail || hasDetails) {
            await mount.updatePath(copyId, { ...(thumbnail && { thumbnail }), ...(hasDetails && { details }) });
        }
        return copyId;
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
