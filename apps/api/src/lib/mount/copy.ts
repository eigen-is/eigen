import { randomUUID } from 'node:crypto';
import type { DriveContainerType, DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FOLDER, isContainerType } from '@workspace/lib/types/drive';
import { ApiError } from '../core';
import { writeTempWithHash } from '../drive/streaming';
import { isVersionsFolder } from '../versioning/versions-folder';
import type { Mount } from './mount';
import { markContentDirty } from './search-index';

// Recursive same-mount copy on one storage backend — the fast path next to the
// cross-mount bridge in drive/copy-across.ts. Containers are recreated (typed) and
// walked; files are re-uploaded from a freshest-first temp copy.
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
        const containerType: DriveContainerType | undefined = isEigenDoc ? src.type : undefined;
        const newId = await mount.createFolder(destParentId, name, containerType);
        if (actor) {
            mount.history.record({ pathId: newId, eventType: 'copied', actor, details: copiedFrom });
        }
        const children = await mount.listFolder(srcPathId);
        for (const child of children) {
            // Inside an eigen-doc container, versions/ is snapshot history — a
            // fresh copy starts clean rather than inheriting old snapshots.
            if (isEigenDoc && isVersionsFolder(child)) continue;
            await copyPath(mount, child.id, newId, child.name, actor);
        }
        // The copied container's data.db is byte-copied as raw bytes — no onSync fires
        // for the new container, so mark it dirty here and kick the reindexer to extract its
        // body. Plain folders have no body and stay unmarked.
        if (isEigenDoc) {
            markContentDirty(mount, newId);
            mount.reindexQueue?.markDirty(newId);
        }
        return mount.getActivePath(newId);
    }

    // Freshest-first source: readFile surfaces an un-acked pending upload's staged bytes (a
    // just-created / outage-staged data.db) rather than the possibly-stale-or-absent storage
    // object. The container branch above flushed the doc first, so its pending staging holds the
    // current bytes; a regular file is never staged, so this is a plain storage read for it.
    const srcFile = await mount.readFile(srcPathId);
    if (!srcFile) throw new ApiError(404, 'Source file missing on storage');
    const tempId = randomUUID();
    const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), srcFile);
    try {
        const newId = await mount.createFileFromTemp(destParentId, name, src.mimeType, size, hash, tempId);
        if (actor) {
            mount.history.record({ pathId: newId, eventType: 'copied', actor, details: copiedFrom });
        }
        return await mount.getActivePath(newId);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}
