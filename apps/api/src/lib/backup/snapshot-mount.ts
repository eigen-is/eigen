import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { buildStorageKey } from '../mount/helpers';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { stageManagedDbCopy } from '../versioning/snapshot';
import { captureFile, captureWrittenFile, normalizeArchiveDatabase } from './capture';

type PathRow = Pick<typeof paths.$inferSelect, 'id' | 'name' | 'type' | 'parentId' | 'trashedFrom'>;

// Where a row's bytes go inside the archive: the storage key it WOULD have on a `local` mount —
// the name chain from the root, with a trash root under `.trash/{id}.{ext}` as trashPath spells it.
// Deriving it from metadata.db instead of the mount's own keys is what makes the archive
// storage-independent: local-key and s3 mounts store flat keys, and restore re-derives whichever
// shape the target mount needs.
function archivePath(row: PathRow, byId: Map<string, PathRow>): string {
    const segments: string[] = [];
    let current: PathRow | undefined = row;
    while (current && current.parentId !== null) {
        segments.unshift(current.trashedFrom ? `.trash/${buildStorageKey(current.id, current.name)}` : current.name);
        current = byId.get(current.parentId);
    }
    return segments.join('/');
}

// Copy every file the mount's paths table knows about into `targetDir`. Walking the table rather
// than the filesystem is what keeps `thumbs/`, `tmp/` and `staging/` out and `.trash/` + `versions/`
// in, on every backend.
export async function snapshotMountData(mount: Mount, targetDir: string, relPrefix: string): Promise<BackupEntry[]> {
    const rows = await mount.db
        .select({
            id: paths.id,
            name: paths.name,
            type: paths.type,
            parentId: paths.parentId,
            trashedFrom: paths.trashedFrom,
        })
        .from(paths)
        .all();
    const byId = new Map(rows.map((row) => [row.id, row]));

    const entries: BackupEntry[] = [];
    for (const row of rows) {
        if (row.type !== 'file') continue;
        const relPath = archivePath(row, byId);
        const destPath = path.join(targetDir, relPath);
        const entryPath = `${relPrefix}/${relPath}`;

        // A container's managed db (data.db, comments.db) has a live handle whose VACUUM INTO holds
        // writes no other source has. The container's path lock keeps the copy off a mid-close
        // checkpoint; the skip-if-contended variant (as versioning/snapshot.ts uses) never parks on
        // a close, and a contended lock falls through to the read below rather than dropping the
        // file — staged and stored bytes are both whole databases.
        if (mount.documentDbs.has(row.id) && row.parentId) {
            const staged = await mount.tryWithPathLock(row.parentId, async () => {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                await stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first');
                return true;
            });
            if (staged) {
                entries.push(await captureWrittenFile(destPath, entryPath));
                continue;
            }
        }

        // readFile is itself freshest-first (pending staged copy, then the stored object). Null means
        // the row has no bytes yet (a touched file whose upload never landed); the archive mirrors
        // that absence rather than inventing an empty object.
        const file = await mount.readFile(row.id);
        if (!file) continue;
        // A closed container db and every versions/ snapshot arrive as plain bytes, so they still
        // carry the live server's journal mode — hash after normalizing, not during the copy.
        if (row.name.endsWith('.db')) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            await Bun.write(destPath, file);
            normalizeArchiveDatabase(destPath);
            entries.push(await captureWrittenFile(destPath, entryPath));
            continue;
        }
        entries.push(await captureFile(file, destPath, entryPath));
    }
    return entries;
}
