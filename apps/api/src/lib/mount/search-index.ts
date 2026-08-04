import type { DrivePath } from '@workspace/lib/types/drive';
import { eq, inArray, sql } from 'drizzle-orm';
import { sanitizeFtsQuery } from '../core';
import { docContainerDescendantIds } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';

// Drive-wide content index (metadata.db v6) + name/body search over the mount's metadata.db.
// The ContentReindexQueue drains the contentDirty bit through the Mount facades for these.

export function upsertPathContent(mount: Mount, pathId: string, body: string): void {
    mount.db.run(sql`
        INSERT INTO path_content (pathId, body) VALUES (${pathId}, ${body})
        ON CONFLICT(pathId) DO UPDATE SET body = excluded.body
    `);
}

export function clearPathContent(mount: Mount, pathId: string): void {
    mount.db.run(sql`DELETE FROM path_content WHERE pathId = ${pathId}`);
}

// Indexable rows whose body is stale: dirty AND (never indexed OR indexed longer ago than
// the cap). The dirty bit is only ever set on a real body write, so this is the work-list;
// `limit` keeps one drain turn (and its id-hydrate) bounded.
export function getContentDirtyPaths(mount: Mount, reindexCapSeconds: number, limit: number): DrivePath[] {
    const dirty = mount.db.all(sql`
        SELECT id FROM paths
        WHERE contentDirty = 1
          AND trashedAt IS NULL
          AND (contentIndexedAt IS NULL OR contentIndexedAt < (unixepoch() - ${reindexCapSeconds}))
        LIMIT ${limit}
    `) as { id: string }[];
    if (dirty.length === 0) return [];
    const ids = dirty.map((r) => r.id);
    const rows = mount.db.select().from(paths).where(inArray(paths.id, ids)).all();
    return rows.map((r) => mount.toDrivePath(r));
}

// Epoch ms when the earliest not-yet-due dirty row becomes eligible, or null if none are
// dirty. A never-indexed row reads as due-now (0) so a row that slipped in mid-drain is never
// stranded. Drives the reindexer's self-timer in place of a poll.
export function earliestPendingReindexAt(mount: Mount, reindexCapSeconds: number): number | null {
    const row = mount.db.all(sql`
        SELECT MIN(CASE WHEN contentIndexedAt IS NULL THEN 0 ELSE contentIndexedAt + ${reindexCapSeconds} END) AS dueSec
        FROM paths
        WHERE contentDirty = 1 AND trashedAt IS NULL
    `) as { dueSec: number | null }[];
    const dueSec = row[0]?.dueSec;
    return dueSec == null ? null : dueSec * 1000;
}

export function markContentIndexed(mount: Mount, pathId: string): void {
    mount.db.update(paths).set({ contentDirty: 0, contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
}

// A failed extract stamps the attempt time but keeps contentDirty = 1, so the cap window defers the
// retry to a later drain instead of dropping the doc from body search (see the reindex catch).
export function markContentIndexAttempted(mount: Mount, pathId: string): void {
    mount.db.update(paths).set({ contentIndexedAt: new Date() }).where(eq(paths.id, pathId)).run();
}

export function searchPaths(mount: Mount, opts: { q: string; limit: number }): DrivePath[] {
    const match = sanitizeFtsQuery(opts.q);
    if (!match) return [];

    // Pass 1a: name hits, FTS-ranked. docContainerDescendantIds keeps eigendoc internals
    // (data.db, embedded media, embedded chats) out — same exclusion as the body pass.
    const nameRanked = mount.db.all(sql`
        SELECT p.id AS id
        FROM paths_fts
        JOIN paths p ON p.rowid = paths_fts.rowid
        WHERE paths_fts MATCH ${match}
          AND p.trashedAt IS NULL
          AND p.parentId IS NOT NULL
          AND p.parentId NOT IN (${docContainerDescendantIds})
        ORDER BY bm25(paths_fts), p.updatedAt DESC, p.id DESC
        LIMIT ${opts.limit}
    `) as { id: string }[];

    // Pass 1b: body hits via the sibling content index.
    const bodyRanked = mount.db.all(sql`
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
    `) as { id: string }[];

    // Merge: name hits first, then body-only hits. The name boost is structural — a
    // file whose name matches always outranks one matched only on body. Dedup by id.
    const seen = new Set<string>();
    const orderedIds: string[] = [];
    for (const r of [...nameRanked, ...bodyRanked]) {
        if (!seen.has(r.id)) {
            seen.add(r.id);
            orderedIds.push(r.id);
        }
    }
    const ids = orderedIds.slice(0, opts.limit);
    if (ids.length === 0) return [];

    // Pass 2: hydrate through Drizzle so timestamp columns come back as Date. Order
    // preserved via the id-keyed map.
    const rows = mount.db.select().from(paths).where(inArray(paths.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => mount.toDrivePath(r));
}

// A container's data.db just synced. Mark the CONTAINER (the data.db's parent) for
// content re-extraction. Gated on the synced file being the primary `data.db` so
// sibling DBs (e.g. comments.db) don't mark the parent. Touches ONLY contentDirty —
// never name/updatedAt — so paths_fts is not churned.
export async function markContainerContentDirty(mount: Mount, dataDbPathId: string): Promise<void> {
    const dataDb = await mount.getPath(dataDbPathId);
    if (dataDb?.name !== 'data.db' || !dataDb.parentId) return;
    mount.reindexQueue?.bumpGeneration(dataDb.parentId);
    await mount.db.update(paths).set({ contentDirty: 1 }).where(eq(paths.id, dataDb.parentId));
    mount.reindexQueue?.kick();
}
