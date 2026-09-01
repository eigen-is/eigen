import { isSearchableTextFile } from '@workspace/lib/constants';
import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const MOUNT_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'mount-metadata',
    currentVersion: 7,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS paths (
                    id TEXT PRIMARY KEY,
                    file TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    parentId TEXT,
                    ownerId TEXT NOT NULL,
                    mimeType TEXT NOT NULL,
                    size INTEGER DEFAULT 0,
                    thumbnail TEXT,
                    acl TEXT,
                    visibility TEXT DEFAULT 'private',
                    sharingRestricted INTEGER NOT NULL DEFAULT 0,
                    details TEXT,
                    hash TEXT,
                    trashedAt INTEGER,
                    trashedFrom TEXT,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch()),
                    FOREIGN KEY (parentId) REFERENCES paths(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_paths_ownerId ON paths(ownerId);
                CREATE INDEX IF NOT EXISTS idx_paths_type ON paths(type);
                CREATE INDEX IF NOT EXISTS idx_paths_mimeType ON paths(mimeType);
                CREATE INDEX IF NOT EXISTS idx_paths_parentId_name ON paths(parentId, name);
                CREATE INDEX IF NOT EXISTS idx_paths_type_parentId ON paths(type, parentId);
                CREATE INDEX IF NOT EXISTS idx_paths_trashed_from
                    ON paths(trashedFrom, trashedAt) WHERE trashedFrom IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_paths_parent_trash
                    ON paths(parentId, trashedAt);
            `),
        },
        {
            version: 2,
            up: (db) =>
                db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS paths_fts USING fts5(
                    name,
                    content='paths',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS paths_ai AFTER INSERT ON paths BEGIN
                    INSERT INTO paths_fts(rowid, name) VALUES (new.rowid, new.name);
                END;

                CREATE TRIGGER IF NOT EXISTS paths_ad AFTER DELETE ON paths BEGIN
                    INSERT INTO paths_fts(paths_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
                END;

                -- Gate on name change so trivial updates (size/hash/thumbnail/trashedAt/acl/details)
                -- don't churn the FTS shadow tables. mail's draft updates rewrite multiple indexed
                -- columns and can't usefully gate; drive only indexes name, so the gate is safe.
                CREATE TRIGGER IF NOT EXISTS paths_au AFTER UPDATE ON paths
                    WHEN old.name IS NOT new.name
                BEGIN
                    INSERT INTO paths_fts(paths_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
                    INSERT INTO paths_fts(rowid, name) VALUES (new.rowid, new.name);
                END;

                INSERT INTO paths_fts(rowid, name) SELECT rowid, name FROM paths;
            `),
        },
        {
            // Non-file rows (folders + eigendoc containers) shift from "always 0" to
            // lazy-computed: NULL = needs recompute, populated on first read.
            version: 3,
            up: (db) =>
                db.exec(`
                UPDATE paths SET size = NULL WHERE type != 'file';
            `),
        },
        {
            // Write-behind upload queue (Phase 1b). Additive; never touches existing rows.
            version: 4,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS pending_uploads (
                    storageKey TEXT PRIMARY KEY,
                    stagingPath TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    enqueuedAt INTEGER NOT NULL,
                    nextAttemptAt INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_pending_uploads_next ON pending_uploads(nextAttemptAt);
            `),
        },
        {
            // File history + watch (Phase 1). Additive; never touches existing rows.
            version: 5,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS file_events (
                    id TEXT PRIMARY KEY,
                    pathId TEXT NOT NULL,
                    eventType TEXT NOT NULL,
                    actorUserId TEXT NOT NULL,
                    actorEmail TEXT NOT NULL,
                    details TEXT,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_file_events_path_created ON file_events(pathId, createdAt);

                CREATE TABLE IF NOT EXISTS path_watchers (
                    pathId TEXT NOT NULL,
                    userId TEXT NOT NULL,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    PRIMARY KEY (pathId, userId),
                    FOREIGN KEY (pathId) REFERENCES paths(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_path_watchers_user ON path_watchers(userId);
            `),
        },
        {
            // Drive-wide content index (Phase 2). Additive + regenerable: a sibling
            // paths_content_fts over a dedicated path_content table keeps large body text
            // off the hot `paths` row. The dirty bit + sweep populate it; the AFTER DELETE
            // ON paths trigger clears the content row. The 5 container type values are the
            // EIGEN_DOC_TYPES frozen at v6 — kept literal so this historical migration never
            // shifts if that constant later changes.
            version: 6,
            up: (db) => {
                db.exec(`
                CREATE TABLE IF NOT EXISTS path_content (
                    pathId TEXT PRIMARY KEY,
                    body TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS paths_content_fts USING fts5(
                    body,
                    content='path_content',
                    content_rowid='rowid',
                    tokenize='porter unicode61'
                );

                CREATE TRIGGER IF NOT EXISTS path_content_ai AFTER INSERT ON path_content BEGIN
                    INSERT INTO paths_content_fts(rowid, body) VALUES (new.rowid, new.body);
                END;
                CREATE TRIGGER IF NOT EXISTS path_content_ad AFTER DELETE ON path_content BEGIN
                    INSERT INTO paths_content_fts(paths_content_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
                END;
                CREATE TRIGGER IF NOT EXISTS path_content_au AFTER UPDATE ON path_content BEGIN
                    INSERT INTO paths_content_fts(paths_content_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
                    INSERT INTO paths_content_fts(rowid, body) VALUES (new.rowid, new.body);
                END;

                -- Atomic cleanup: a deleted path takes its content row (and FTS shadow) with it.
                CREATE TRIGGER IF NOT EXISTS path_content_cleanup AFTER DELETE ON paths BEGIN
                    DELETE FROM path_content WHERE pathId = old.id;
                END;

                ALTER TABLE paths ADD COLUMN contentDirty INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE paths ADD COLUMN contentIndexedAt INTEGER;

                -- Backfill containers: mark every eigendoc-type row dirty so the first sweep
                -- indexes pre-existing content. Touches ONLY contentDirty (not name/updatedAt),
                -- so paths_fts is untouched.
                UPDATE paths SET contentDirty = 1
                WHERE trashedAt IS NULL
                  AND type IN ('doc', 'sheets', 'slides', 'stickies', 'chat');
            `);

                // Backfill plaintext/code files through the canonical eligibility gate
                // (getTextPreviewMode) so the rule lives in exactly one place. Raw bun:sqlite
                // query/prepare on the migration db.
                const files = db
                    .query(`SELECT id, name, mimeType FROM paths WHERE type = 'file' AND trashedAt IS NULL`)
                    .all() as { id: string; name: string; mimeType: string }[];
                const mark = db.prepare(`UPDATE paths SET contentDirty = 1 WHERE id = ?`);
                for (const f of files) {
                    if (isSearchableTextFile(f.mimeType, f.name)) mark.run(f.id);
                }
                mark.finalize();
            },
        },
        {
            // Close the concurrent same-name-create race (AUDIT_MOUNT finding 27). assertUniqueName's
            // SELECT and the storage-write-then-INSERT that follows it aren't serialized, so two racers
            // both pass the check and both insert. On the path-based `local` backend both rows get
            // file = name → the SAME disk path → the second write clobbers the first and deleting either
            // deletes both. A partial UNIQUE INDEX makes the losing INSERT throw (translated to 409 in
            // mount.ts), and it hardens id-based (s3/local-key) metadata against duplicate active names.
            //
            // Runs inside the ManagedDatabase migration transaction (BEGIN/COMMIT with ROLLBACK on throw),
            // so a failure leaves the db at v6 untouched.
            version: 7,
            up: (db) => {
                // A1 — DEDUP PRE-STEP. On a LIVE db CREATE UNIQUE INDEX FAILS if a duplicate already
                // exists, so first make (parentId, LOWER(name)) unique by RENAMING every colliding row
                // except the oldest. Scope = trashedFrom IS NULL: LIVE rows (what the index constrains)
                // PLUS folder-descendant-trashed rows (trashedAt set by trashDescendants, trashedFrom
                // NULL) — restoreDescendants bulk-restores that whole cohort in one recursive UPDATE
                // with no conflict handling, so a pre-v7 duplicate surviving inside an already-trashed
                // folder would trip the index on restore and permanently brick it. Independently-trashed
                // rows (trashedFrom SET) are excluded: they restore one at a time through restorePath's
                // conflict rename and may legitimately duplicate a live name (trash-then-recreate).
                // RENAME `name` ONLY — never touch `file`:
                //   - id-based (s3/local-key): file = `${id}.${ext}` is keyed by the immutable ROW ID,
                //     independent of name, so renaming (extension preserved) leaves both distinct storage
                //     objects valid → lossless. The collision was a metadata-only clash.
                //   - path-based (local): file = name (old) is left as-is, so the renamed row still
                //     resolves to the SAME already-shared disk path. That clobber predates this migration
                //     and can't be undone; renaming introduces NO NEW loss and makes the index satisfiable.
                // parentId IS NULL is excluded: SQLite treats NULLs as distinct in a unique index, so
                // roots never collide and must not be renamed.

                // Mirror SQLite's ASCII-only LOWER() — the index and assertUniqueName both fold with it —
                // so the dedup renames EXACTLY the rows CREATE UNIQUE INDEX would reject, no more (a JS
                // toLowerCase would over-fold non-ASCII case variants SQLite keeps distinct).
                const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
                // Suffix goes BEFORE the extension; a leading dot is a dotfile, not an extension
                // (matches buildStorageKey's dotIdx > 0 rule).
                const split = (name: string): { base: string; ext: string } => {
                    const dot = name.lastIndexOf('.');
                    return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
                };

                const parents = db
                    .query(`
                        SELECT DISTINCT parentId FROM (
                            SELECT parentId FROM paths
                            WHERE trashedFrom IS NULL AND parentId IS NOT NULL
                            GROUP BY parentId, LOWER(name)
                            HAVING COUNT(*) > 1
                        )
                    `)
                    .all() as { parentId: string }[];

                const cohortInParent = db.query(
                    `SELECT id, name FROM paths WHERE parentId = ? AND trashedFrom IS NULL ORDER BY createdAt ASC, rowid ASC`,
                );
                const rename = db.prepare(`UPDATE paths SET name = ? WHERE id = ?`);

                for (const { parentId } of parents) {
                    const rows = cohortInParent.all(parentId) as { id: string; name: string }[];
                    // Every lower-name in the parent's dedup cohort, so a generated suffix collides
                    // with nothing live now or after a folder restore.
                    const taken = new Set(rows.map((r) => lower(r.name)));
                    // Group by lower-name in oldest-first order; the first row of each group keeps its name.
                    const groups = new Map<string, { id: string; name: string }[]>();
                    for (const r of rows) {
                        const key = lower(r.name);
                        const g = groups.get(key);
                        if (g) g.push(r);
                        else groups.set(key, [r]);
                    }
                    for (const group of groups.values()) {
                        for (const dup of group.slice(1)) {
                            const { base, ext } = split(dup.name);
                            let n = 2;
                            let candidate = `${base} (${n})${ext}`;
                            while (taken.has(lower(candidate))) {
                                n += 1;
                                candidate = `${base} (${n})${ext}`;
                            }
                            taken.add(lower(candidate));
                            rename.run(candidate, dup.id);
                        }
                    }
                }
                rename.finalize();

                // A2 — the partial unique index. LOWER(name) + non-trashed scope match getChildByName /
                // assertUniqueName exactly; trashed rows are excluded so a trashed item doesn't block
                // re-creating a live one. IF NOT EXISTS keeps a re-run a no-op.
                db.exec(
                    `CREATE UNIQUE INDEX IF NOT EXISTS idx_paths_unique_active_name ON paths(parentId, LOWER(name)) WHERE trashedAt IS NULL;`,
                );
            },
        },
    ],
};
