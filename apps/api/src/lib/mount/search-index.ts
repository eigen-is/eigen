// Drive search over one mount's metadata.db: the names of its paths, and the text of each file's body in a
// content index beside them. The content reindex queue keeps that index current. It finds the paths whose body
// changed through the dirty mark set here, and writes each new body back. Mount reaches these functions for
// its search and reindex work, and a synced data.db marks its document as changed.

import type { DrivePath } from '@workspace/lib/types/drive';
import { eq, inArray, sql } from 'drizzle-orm';
import { sanitizeFtsQuery } from '../core';
import { CONTAINER_DATA_DB } from './container-dbs';
import { docContainerDescendantIds } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';

export function upsertPathContent(mount: Mount, pathId: string, body: string): void {
    mount.db.run(sql`
        INSERT INTO path_content (pathId, body) VALUES (${pathId}, ${body})
        ON CONFLICT(pathId) DO UPDATE SET body = excluded.body
    `);
}

export function clearPathContent(mount: Mount, pathId: string): void {
    mount.db.run(sql`DELETE FROM path_content WHERE pathId = ${pathId}`);
}

// The paths whose body changed and is due again: never indexed, or indexed longer ago than the cap. Only a real
// write of a body sets the dirty mark, so this is the list of work. The limit keeps one turn of the queue small.
export function getContentDirtyPaths(mount: Mount, reindexCapSeconds: number, limit: number): DrivePath[] {
    const dirty = mount.db.all<{ id: string }>(sql`
        SELECT id FROM paths
        WHERE contentDirty = 1
          AND trashedAt IS NULL
          AND (contentIndexedAt IS NULL OR contentIndexedAt < (unixepoch() - ${reindexCapSeconds}))
        LIMIT ${limit}
    `);
    if (dirty.length === 0) return [];
    const ids = dirty.map((r) => r.id);
    const rows = mount.db.select().from(paths).where(inArray(paths.id, ids)).all();
    return rows.map((r) => mount.toDrivePath(r));
}

// When the first changed path that is not due yet becomes due, in epoch ms, or null when nothing changed. A path
// never indexed is due at once, so a path marked during a turn is never left behind. The queue sets its timer
// by it instead of polling.
export function earliestPendingReindexAt(mount: Mount, reindexCapSeconds: number): number | null {
    const row = mount.db.all<{ dueSec: number | null }>(sql`
        SELECT MIN(CASE WHEN contentIndexedAt IS NULL THEN 0 ELSE contentIndexedAt + ${reindexCapSeconds} END) AS dueSec
        FROM paths
        WHERE contentDirty = 1 AND trashedAt IS NULL
    `);
    const dueSec = row[0]?.dueSec;
    return dueSec == null ? null : dueSec * 1000;
}

export function markContentDirty(mount: Mount, pathId: string): void {
    mount.db.update(paths).set({ contentDirty: 1 }).where(eq(paths.id, pathId)).run();
}

export function markContentIndexed(mount: Mount, pathId: string): void {
    mount.db.update(paths).set({ contentDirty: 0, contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
}

// A failed extract stamps the time of the try but keeps the dirty mark. The cap then puts the retry off to a later
// turn, and the document stays in body search meanwhile.
export function markContentIndexAttempted(mount: Mount, pathId: string): void {
    mount.db.update(paths).set({ contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
}

export function searchPaths(mount: Mount, opts: { q: string; limit: number }): DrivePath[] {
    const match = sanitizeFtsQuery(opts.q);
    if (!match) return [];

    // The parts inside a document, such as its data.db, its media and its comment threads, are left out of both
    // passes (docContainerDescendantIds).
    const nameRanked = mount.db.all<{ id: string }>(sql`
        SELECT p.id AS id
        FROM paths_fts
        JOIN paths p ON p.rowid = paths_fts.rowid
        WHERE paths_fts MATCH ${match}
          AND p.trashedAt IS NULL
          AND p.parentId IS NOT NULL
          AND p.parentId NOT IN (${docContainerDescendantIds})
        ORDER BY bm25(paths_fts), p.updatedAt DESC, p.id DESC
        LIMIT ${opts.limit}
    `);

    const bodyRanked = mount.db.all<{ id: string }>(sql`
        SELECT p.id AS id
        FROM paths_content_fts
        JOIN path_content pc ON pc.rowid = paths_content_fts.rowid
        JOIN paths p ON p.id = pc.pathId
        WHERE paths_content_fts MATCH ${match}
          AND p.trashedAt IS NULL
          AND p.parentId IS NOT NULL
          AND p.parentId NOT IN (${docContainerDescendantIds})
        ORDER BY bm25(paths_content_fts), p.updatedAt DESC, p.id DESC
        LIMIT ${opts.limit}
    `);

    // A file whose name matches always comes before one that matches only by its body.
    const ids = [...new Set([...nameRanked, ...bodyRanked].map((r) => r.id))].slice(0, opts.limit);
    if (ids.length === 0) return [];

    // The rows are read again through Drizzle, so the timestamps come back as Date, in the order of the hits.
    const rows = mount.db.select().from(paths).where(inArray(paths.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => mount.toDrivePath(r));
}

// A document's data.db just synced, so the document's text is read again. Another database in it, such as its
// comments.db, marks nothing. Only the dirty mark changes, never the name or updatedAt, so the name index is left
// alone.
export async function markContainerContentDirty(mount: Mount, dataDbPathId: string): Promise<void> {
    const dataDb = await mount.getPath(dataDbPathId);
    if (dataDb?.name !== CONTAINER_DATA_DB || !dataDb.parentId) return;
    mount.reindexQueue?.bumpGeneration(dataDb.parentId);
    markContentDirty(mount, dataDb.parentId);
    mount.reindexQueue?.kick();
}
