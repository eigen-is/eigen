// The local temp folder of one mount, where bytes wait between storage and the code that works on them,
// such as a document database's working copy, an upload on its way in or a download for a conversion. Mount
// calls these for Drive, versioning and the document databases, and sweeps stale files from the folder at
// mount open.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { storageGone } from '../core';
import type { StorageFile } from '../storage';
import { isMissingObjectCause, writeTempWithHash } from '../storage';
import type { Mount } from './mount';
import { paths } from './schema';

export function getTempPath(mount: Mount, pathId: string): string {
    return path.join(mount.tmpDir, pathId.replace(/\//g, '_'));
}

// tempId is new for each call, such as a randomUUID, or two downloads of one file would overwrite each other. Only
// a document open passes the path id, which names its working copy.
export async function downloadToTemp(mount: Mount, pathId: string, tempId: string): Promise<string> {
    // Under the tree lock, because on `local` an ancestor rename during the read would make the file look gone.
    return mount.withTreeShared(async () => {
        const storageKey = await mount.getStorageKey(pathId);
        const tempPath = mount.getTempPath(tempId);
        await mount.cleanupTemp(tempId);
        // A -wal that survived the cleanup would be replayed into the fresh main file.
        if (fs.existsSync(`${tempPath}-wal`))
            throw new Error(`[Mount] download ${storageKey}: stale ${tempPath}-wal could not be removed`);
        // Freshest first, like readKey: bytes saved during an outage exist only as their staged copy.
        const staged = mount.pendingStagedCopy(storageKey);
        if (staged) {
            try {
                await mount.replaceTempFrom(tempId, Bun.file(staged));
                return tempPath;
            } catch (err) {
                // The queue unlinks a staged copy once its upload landed, which may happen during the
                // read. The bytes are in the bucket by then, so the download below gets them.
                if (!isMissingObjectCause(err)) {
                    console.error(`[Mount] download of staged ${storageKey} failed:`, err);
                    throw err;
                }
            }
        }
        const start = Bun.nanoseconds();
        let size: number;
        try {
            size = await mount.replaceTempFrom(tempId, mount.storage.read(storageKey));
        } catch (err) {
            console.error(`[Mount] download ${storageKey} failed:`, err);
            // Only a missing object in the GET body is a 410. A raw error is local, such as the tmp/ write, so
            // it stays a 500 even as an ENOENT.
            if (isMissingObjectCause(err)) throw storageGone(err.cause);
            throw err;
        }
        const ms = (Bun.nanoseconds() - start) / 1_000_000;
        console.log(`[timing] Mount.download ${storageKey} ${(size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
        return tempPath;
    });
}

// Through a side file, because the next open would adopt a truncated file at the temp path as crash recovery.
export async function replaceTempFrom(mount: Mount, tempId: string, source: StorageFile): Promise<number> {
    const sideId = crypto.randomUUID();
    let size: number;
    try {
        ({ size } = await writeTempWithHash(mount.getTempPath(sideId), source, { signal: mount.downloads.signal }));
        fs.renameSync(mount.getTempPath(sideId), mount.getTempPath(tempId));
    } catch (err) {
        await mount.cleanupTemp(sideId);
        throw err;
    }
    return size;
}

export async function uploadFromTemp(mount: Mount, storageKey: string, tempId: string): Promise<void> {
    const start = Bun.nanoseconds();
    const size = await mount.storage.write(storageKey, Bun.file(mount.getTempPath(tempId)));
    const ms = (Bun.nanoseconds() - start) / 1_000_000;
    console.log(`[timing] Mount.upload ${storageKey} ${(size / 1024) | 0}KB ${ms.toFixed(1)}ms`);
}

export async function cleanupTemp(mount: Mount, tempId: string): Promise<void> {
    const tempPath = mount.getTempPath(tempId);
    // The journals go too: SQLite replays a leftover -wal into whatever main file lands here next.
    try {
        fs.rmSync(`${tempPath}-wal`, { force: true });
        fs.rmSync(`${tempPath}-shm`, { force: true });
        fs.rmSync(tempPath, { force: true });
    } catch (e) {
        console.error(`[Mount] Failed to remove temp ${tempId}:`, e);
    }
}

export function cleanupStaleFiles(mount: Mount, dir: string, maxAgeMs: number, preserveLivePathIds = false): void {
    try {
        const cutoff = Date.now() - maxAgeMs;
        // An entry named after a live path id is a crash temp that only its document's next open adopts,
        // however old it is, so it stays with its unsynced edits.
        const liveIds = preserveLivePathIds
            ? new Set(
                  mount.db
                      .select({ id: paths.id })
                      .from(paths)
                      .all()
                      .map((row) => row.id),
              )
            : null;
        for (const entry of fs.readdirSync(dir)) {
            // A crash temp's journals hold its unsynced tail, so they stay with it.
            if (liveIds?.has(entry.replace(/-(wal|shm|journal)$/, ''))) continue;
            const filePath = path.join(dir, entry);
            try {
                if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
            } catch {}
        }
    } catch {}
}
