// The sizes of one mount: the bytes and the number of its files, and the size of each folder, which its
// paths row caches. A write clears the cached size of every folder above it, and the next read of such a
// folder computes it again and stores it. Mount calls these for its own writes and for Drive, such as for
// the quota, and its sibling modules, such as trash, clear sizes after theirs.

import type { MountInfo } from '@workspace/lib/types/mount';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../core';
import type { Mount } from './mount';
import type * as schema from './schema';
import { paths } from './schema';

// Trashed files count, as their bytes are still stored. An aggregate answers exactly one row.
export async function getFileTotals(mount: Mount): Promise<Pick<MountInfo, 'totalSize' | 'fileCount'>> {
    const [totals] = await mount.db
        .select({ totalSize: sql<number>`COALESCE(SUM(${paths.size}), 0)`, fileCount: sql<number>`COUNT(*)` })
        .from(paths)
        .where(eq(paths.type, 'file'))
        .all();
    return totals;
}

export async function invalidateAncestorsOf(mount: Mount, pathId: string): Promise<void> {
    const row = await mount.db.select({ parentId: paths.parentId }).from(paths).where(eq(paths.id, pathId)).get();
    await mount.invalidateSizesFrom(row?.parentId ?? null);
}

// Clears the cached size of parentId and of every folder above it. Every caller has committed its
// change already, so a failure is logged and leaves a stale size instead of a 500.
export async function invalidateSizesFrom(mount: Mount, parentId: string | null): Promise<void> {
    if (!parentId) return;
    try {
        await mount.db.run(sql`
            WITH RECURSIVE ancestors(id) AS (
                SELECT ${parentId} AS id
                UNION ALL
                SELECT p.parentId FROM paths p
                    JOIN ancestors a ON p.id = a.id
                    WHERE p.parentId IS NOT NULL
            )
            UPDATE paths SET size = NULL WHERE id IN (SELECT id FROM ancestors)
        `);
    } catch (e) {
        console.error(`[Mount] Could not invalidate the folder sizes from ${parentId}:`, e);
    }
}

export function computeFolderSizeInTx(tx: Tx<typeof schema>, folderId: string): number {
    const row = tx.select({ size: paths.size, type: paths.type }).from(paths).where(eq(paths.id, folderId)).get();
    if (!row) return 0;
    if (row.type === 'file') return row.size ?? 0;
    if (row.size !== null) return row.size;

    // A trashed item moves to the root but keeps its trashedFrom, so it does not count there. The
    // items trashed along with it stay in its subtree and count toward its own size, as in Google Drive.
    const children = tx
        .select({ id: paths.id, size: paths.size, type: paths.type })
        .from(paths)
        .where(and(eq(paths.parentId, folderId), isNull(paths.trashedFrom)))
        .all();

    let total = 0;
    for (const child of children) {
        total += child.size ?? (child.type === 'file' ? 0 : computeFolderSizeInTx(tx, child.id));
    }

    tx.update(paths).set({ size: total }).where(eq(paths.id, folderId)).run();
    return total;
}
