import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { MOUNT_DB_CONFIG } from '../lib/mount/db-config';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';

const UNIQUE_INDEX = 'idx_paths_unique_active_name';
const INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON paths(parentId, LOWER(name)) WHERE trashedAt IS NULL;`;

// Fresh in-memory db migrated to v6 — the on-disk shape a LIVE mount presents before this task's v7.
function seedV6Db(): Database {
    const db = new Database(':memory:');
    for (const m of MOUNT_DB_CONFIG.migrations.filter((m) => m.version <= 6)) m.up(db);
    return db;
}

type SeedRow = {
    id: string;
    name: string;
    parentId: string | null;
    type?: string;
    // id-based mounts store file = `${id}.${ext}`, keyed by the immutable row id and independent of
    // name; seeding distinct file values proves the dedup leaves both storage objects intact.
    file?: string;
    createdAt: number;
    trashedAt?: number | null;
};

function insertRow(db: Database, r: SeedRow): void {
    db.prepare(
        `INSERT INTO paths (id, file, name, type, parentId, ownerId, mimeType, createdAt, updatedAt, trashedAt)
         VALUES (?, ?, ?, ?, ?, 'owner', 'application/octet-stream', ?, ?, ?)`,
    ).run(r.id, r.file ?? r.name, r.name, r.type ?? 'file', r.parentId, r.createdAt, r.createdAt, r.trashedAt ?? null);
}

function v7(): { up: (db: Database) => void } {
    const m = MOUNT_DB_CONFIG.migrations.find((mm) => mm.version === 7);
    if (!m) throw new Error('v7 migration not found');
    return m;
}

function nameOf(db: Database, id: string): string {
    return (db.query(`SELECT name FROM paths WHERE id = ?`).get(id) as { name: string }).name;
}

function fileOf(db: Database, id: string): string {
    return (db.query(`SELECT file FROM paths WHERE id = ?`).get(id) as { file: string }).file;
}

function hasUniqueIndex(db: Database): boolean {
    return !!db.query(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`).get(UNIQUE_INDEX);
}

describe('v7 unique-active-name migration', () => {
    // Load-bearing RED proof: on a live db that already contains a (parentId, LOWER(name)) collision,
    // the bare CREATE UNIQUE INDEX FAILS — which is exactly why the migration needs a dedup pre-step.
    test('bare CREATE UNIQUE INDEX throws on pre-existing dupes (why the dedup exists)', () => {
        const db = seedV6Db();
        insertRow(db, { id: 'a', name: 'Foo.txt', parentId: 'p', file: 'a.txt', createdAt: 1000 });
        insertRow(db, { id: 'b', name: 'foo.txt', parentId: 'p', file: 'b.txt', createdAt: 2000 });
        expect(() => db.exec(INDEX_DDL)).toThrow(/UNIQUE constraint failed/);
        db.close();
    });

    test('heals pre-existing dupes: oldest keeps name, others renamed, files untouched, index created', () => {
        const db = seedV6Db();
        // Two file dupes + a folder pair in the same parent; the OLDER createdAt is the canonical.
        insertRow(db, { id: 'a', name: 'Foo.txt', parentId: 'p', file: 'a.txt', createdAt: 1000 });
        insertRow(db, { id: 'b', name: 'foo.txt', parentId: 'p', file: 'b.txt', createdAt: 2000 });
        insertRow(db, { id: 'c', name: 'Docs', parentId: 'p', type: 'folder', file: 'Docs', createdAt: 1000 });
        insertRow(db, { id: 'd', name: 'docs', parentId: 'p', type: 'folder', file: 'docs', createdAt: 2000 });
        // A trashed dupe must NOT be renamed (the index excludes trashed rows).
        insertRow(db, { id: 'e', name: 'foo.txt', parentId: 'p', file: 'e.txt', createdAt: 3000, trashedAt: 500 });
        // Same names in a DIFFERENT parent must not be touched (scoped per parent).
        insertRow(db, { id: 'f', name: 'foo.txt', parentId: 'q', file: 'f.txt', createdAt: 1000 });

        expect(() => v7().up(db)).not.toThrow();

        expect(hasUniqueIndex(db)).toBe(true);
        // Oldest kept verbatim; the newer collider renamed, extension preserved.
        expect(nameOf(db, 'a')).toBe('Foo.txt');
        expect(nameOf(db, 'b')).toBe('foo (2).txt');
        expect(nameOf(db, 'c')).toBe('Docs');
        expect(nameOf(db, 'd')).toBe('docs (2)');
        // Trashed + other-parent rows untouched.
        expect(nameOf(db, 'e')).toBe('foo.txt');
        expect(nameOf(db, 'f')).toBe('foo.txt');
        // file column NEVER rewritten → id-based getStorageKey (returns row.file) still points at the
        // original distinct object for every row: lossless.
        expect(fileOf(db, 'a')).toBe('a.txt');
        expect(fileOf(db, 'b')).toBe('b.txt');
        expect(fileOf(db, 'd')).toBe('docs');

        // The index now enforces uniqueness: another live 'FOO.TXT' in parent p is rejected.
        expect(() =>
            insertRow(db, { id: 'z', name: 'FOO.TXT', parentId: 'p', file: 'z.txt', createdAt: 9000 }),
        ).toThrow(/UNIQUE constraint failed/);
        db.close();
    });

    test('is idempotent: re-running up() is a clean no-op', () => {
        const db = seedV6Db();
        insertRow(db, { id: 'a', name: 'Foo.txt', parentId: 'p', file: 'a.txt', createdAt: 1000 });
        insertRow(db, { id: 'b', name: 'foo.txt', parentId: 'p', file: 'b.txt', createdAt: 2000 });
        v7().up(db);
        const after = nameOf(db, 'b');
        // Second run: no collisions remain, index already present → nothing changes, no throw.
        expect(() => v7().up(db)).not.toThrow();
        expect(nameOf(db, 'b')).toBe(after);
        expect(nameOf(db, 'a')).toBe('Foo.txt');
        db.close();
    });

    test('several collisions in one parent get sequential suffixes', () => {
        const db = seedV6Db();
        insertRow(db, { id: 'a', name: 'note', parentId: 'p', file: 'a', createdAt: 1000 });
        insertRow(db, { id: 'b', name: 'Note', parentId: 'p', file: 'b', createdAt: 2000 });
        insertRow(db, { id: 'c', name: 'NOTE', parentId: 'p', file: 'c', createdAt: 3000 });
        v7().up(db);
        expect(nameOf(db, 'a')).toBe('note');
        expect(nameOf(db, 'b')).toBe('Note (2)');
        expect(nameOf(db, 'c')).toBe('NOTE (3)');
        db.close();
    });
});

describe('concurrent same-name create → exactly one 409', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-unique-name-${Date.now()}`);

    function getLocalDatabase(baseDir: string) {
        return async <S extends SchemaType>(
            config: DatabaseConfig<S>,
            relativePath: string,
        ): Promise<ManagedDatabase<S>> => {
            const db = new ManagedDatabase(config, join(baseDir, relativePath));
            await db.open(0);
            return db;
        };
    }

    beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    async function raceOnBackend(storageType: 'local' | 'local-key'): Promise<void> {
        const config = createDefaultMountConfig(`race-${storageType}`, storageType);
        const mount = new Mount('owner', TEST_DIR, config, getLocalDatabase(TEST_DIR));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        // Both requests pass assertUniqueName's SELECT (neither has inserted yet), then both INSERT;
        // the DB serializes the inserts and the loser trips the v7 index → 409, not a clobber.
        const results = await Promise.allSettled([
            mount.createFile(rootId, 'race.txt', 'text/plain', 5, Buffer.from('hello')),
            mount.createFile(rootId, 'race.txt', 'text/plain', 5, Buffer.from('world')),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toBeInstanceOf(ApiError);
        expect((rejected[0].reason as ApiError).status).toBe(409);

        const children = await mount.listFolder(rootId);
        expect(children.filter((c) => c.name === 'race.txt').length).toBe(1);

        await mount.closeAllDatabases();
    }

    test('path-based (local) mount', () => raceOnBackend('local'));
    test('id-based (local-key) mount', () => raceOnBackend('local-key'));
});
