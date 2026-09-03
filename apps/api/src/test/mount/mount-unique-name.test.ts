import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { MOUNT_DB_CONFIG } from '../../lib/mount/db-config';
import { Mount } from '../../lib/mount/mount';
import { createTestMountConfig } from '../mount-test-helpers';

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
    trashedFrom?: string | null;
};

function insertRow(db: Database, r: SeedRow): void {
    db.prepare(
        `INSERT INTO paths (id, file, name, type, parentId, ownerId, mimeType, createdAt, updatedAt, trashedAt, trashedFrom)
         VALUES (?, ?, ?, ?, ?, 'owner', 'application/octet-stream', ?, ?, ?, ?)`,
    ).run(
        r.id,
        r.file ?? r.name,
        r.name,
        r.type ?? 'file',
        r.parentId,
        r.createdAt,
        r.createdAt,
        r.trashedAt ?? null,
        r.trashedFrom ?? null,
    );
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
        // An INDEPENDENTLY-trashed dupe (trashedFrom SET) must NOT be renamed — it restores one at a
        // time through restorePath's conflict rename, and may legitimately duplicate a live name.
        insertRow(db, {
            id: 'e',
            name: 'foo.txt',
            parentId: 'p',
            file: 'e.txt',
            createdAt: 3000,
            trashedAt: 500,
            trashedFrom: 'p',
        });
        // A FOLDER-DESCENDANT-trashed dupe (trashedAt set, trashedFrom NULL) IS renamed —
        // restoreDescendants bulk-restores that cohort with no conflict handling.
        insertRow(db, { id: 'g', name: 'foo.txt', parentId: 'p', file: 'g.txt', createdAt: 4000, trashedAt: 500 });
        // Same names in a DIFFERENT parent must not be touched (scoped per parent).
        insertRow(db, { id: 'f', name: 'foo.txt', parentId: 'q', file: 'f.txt', createdAt: 1000 });

        expect(() => v7().up(db)).not.toThrow();

        expect(hasUniqueIndex(db)).toBe(true);
        // Oldest kept verbatim; the newer collider renamed, extension preserved.
        expect(nameOf(db, 'a')).toBe('Foo.txt');
        expect(nameOf(db, 'b')).toBe('foo (2).txt');
        expect(nameOf(db, 'c')).toBe('Docs');
        expect(nameOf(db, 'd')).toBe('docs (2)');
        // Independently-trashed + other-parent rows untouched; the descendant-trashed dupe renamed
        // into the same per-parent suffix sequence as the live colliders.
        expect(nameOf(db, 'e')).toBe('foo.txt');
        expect(nameOf(db, 'f')).toBe('foo.txt');
        expect(nameOf(db, 'g')).toBe('foo (3).txt');
        // file column NEVER rewritten → id-based getStorageKey (returns row.file) still points at the
        // original distinct object for every row: lossless.
        expect(fileOf(db, 'a')).toBe('a.txt');
        expect(fileOf(db, 'b')).toBe('b.txt');
        expect(fileOf(db, 'd')).toBe('docs');
        expect(fileOf(db, 'g')).toBe('g.txt');

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
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-unique-name-${Date.now()}`);

    beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    async function raceOnBackend(storageType: 'local' | 'local-key'): Promise<void> {
        const config = createTestMountConfig(`race-${storageType}`, storageType);
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

    // The index also constrains UPDATEs: a raced rename/move that would collide must surface as the
    // same 409 the create path raises, not a raw UNIQUE-constraint 500.
    async function renameRaceOnBackend(storageType: 'local' | 'local-key'): Promise<void> {
        const config = createTestMountConfig(`rename-race-${storageType}`, storageType);
        const mount = new Mount('owner', TEST_DIR, config, getLocalDatabase(TEST_DIR));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const one = await mount.createFile(rootId, 'one.txt', 'text/plain', 1, Buffer.from('1'));
        const two = await mount.createFile(rootId, 'two.txt', 'text/plain', 1, Buffer.from('2'));

        // Both racers pass assertUniqueName's SELECT (no 'same.txt' yet); the loser's UPDATE trips
        // the index → translated to 409.
        const results = await Promise.allSettled([
            mount.updatePath(one, { name: 'same.txt' }),
            mount.updatePath(two, { name: 'same.txt' }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0].reason).toBeInstanceOf(ApiError);
        expect((rejected[0].reason as ApiError).status).toBe(409);

        const children = await mount.listFolder(rootId);
        expect(children.filter((c) => c.name === 'same.txt').length).toBe(1);

        await mount.closeAllDatabases();
    }

    test('raced rename to the same name → 409, path-based (local)', () => renameRaceOnBackend('local'));
    test('raced rename to the same name → 409, id-based (local-key)', () => renameRaceOnBackend('local-key'));

    // Pins the translation's precision: rethrowDuplicateActiveName must map ONLY the
    // idx_paths_unique_active_name violation to 409. A duplicate paths.id (PRIMARY KEY) through the
    // same insert seam is a real bug, not a name race — it must re-throw raw, not become a 409.
    test('a duplicate paths.id violation re-throws raw instead of mapping to 409', async () => {
        const config = createTestMountConfig('pk-precision', 'local-key');
        const mount = new Mount('owner', TEST_DIR, config, getLocalDatabase(TEST_DIR));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const existingId = await mount.createFile(rootId, 'pk-one.txt', 'text/plain', 1, Buffer.from('1'));

        // A DIFFERENT name (no active-name collision) with the SAME id → pure PK violation.
        const { insertPathRow } = mount as unknown as {
            insertPathRow: (values: Record<string, unknown>) => Promise<void>;
        };
        const err = await insertPathRow
            .call(mount, {
                id: existingId,
                name: 'pk-two.txt',
                type: 'file',
                parentId: rootId,
                ownerId: 'owner',
                mimeType: 'text/plain',
            })
            .then(() => null)
            .catch((e: unknown) => e);

        expect(err).not.toBeNull();
        expect(err).not.toBeInstanceOf(ApiError);
        expect((err as Error).message).toMatch(/UNIQUE constraint failed: paths\.id/);

        await mount.closeAllDatabases();
    });
});

describe('v7 dedup covers the folder restore-from-trash cohort', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-unique-name-restore-${Date.now()}`);

    beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    // A pre-v7 duplicate pair inside a folder that was trashed BEFORE the v7 deploy has trashedAt SET
    // and trashedFrom NULL — outside a live-only dedup, but bulk-restored by restoreDescendants' single
    // recursive UPDATE with no conflict handling. If the dedup skipped it, restoring the folder would
    // trip the unique index and throw a raw SQLiteError (500), permanently bricking the restore.
    test('restoring a folder whose subtree held pre-v7 dupes succeeds after v7', async () => {
        const mountId = 'restore-dupes';
        // Pre-seed the on-disk metadata.db at v6 — the exact shape a live mount presents at deploy.
        const dbDir = join(TEST_DIR, 'mounts', mountId);
        mkdirSync(dbDir, { recursive: true });
        const raw = new Database(join(dbDir, 'metadata.db'));
        for (const m of MOUNT_DB_CONFIG.migrations.filter((mm) => mm.version <= 6)) m.up(raw);
        raw.exec(`
            CREATE TABLE __schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0);
            INSERT INTO __schema_version (id, version) VALUES (1, 6);
        `);
        // Recent epochs so init's trash-retention purge can't touch the seeded rows.
        const now = Math.floor(Date.now() / 1000);
        insertRow(raw, { id: 'root', name: 'Drive', parentId: null, type: 'folder', file: '', createdAt: now - 400 });
        insertRow(raw, {
            id: 'folder',
            name: 'Project',
            parentId: 'root',
            type: 'folder',
            file: '',
            createdAt: now - 300,
            trashedAt: now - 60,
            trashedFrom: 'root',
        });
        insertRow(raw, {
            id: 'a',
            name: 'Dup.txt',
            parentId: 'folder',
            file: 'a.txt',
            createdAt: now - 200,
            trashedAt: now - 60,
        });
        insertRow(raw, {
            id: 'b',
            name: 'dup.txt',
            parentId: 'folder',
            file: 'b.txt',
            createdAt: now - 100,
            trashedAt: now - 60,
        });
        raw.close();

        // Mount.init opens via ManagedDatabase → runs v7 on the seeded v6 db.
        const mount = new Mount(
            'owner',
            TEST_DIR,
            createTestMountConfig(mountId, 'local-key'),
            getLocalDatabase(TEST_DIR),
        );
        await mount.init();

        // The dedup healed the trashedFrom-NULL cohort: distinct names, file column untouched.
        expect((await mount.getPath('a'))!.name).toBe('Dup.txt');
        expect((await mount.getPath('b'))!.name).toBe('dup (2).txt');

        // Pre-fix RED: restoreDescendants' bulk UPDATE trips idx_paths_unique_active_name and throws.
        const restored = await mount.restorePath('folder');
        expect(restored.trashedAt).toBeNull();
        const children = await mount.listFolder('folder'); // live rows only
        expect(children.map((c) => c.id).sort()).toEqual(['a', 'b']);
        expect(new Set(children.map((c) => c.name.toLowerCase())).size).toBe(2);

        await mount.closeAllDatabases();
    });
});

describe('NFC filename normalization on write', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-nfc-write-${Date.now()}`);

    beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
    afterAll(() => {
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {}
    });

    // macOS clients emit NFD-decomposed names; writes normalize to NFC, so a later NFC create of the
    // same name collides on the unique index instead of forking a look-alike twin. On a path-based mount
    // it also keeps the stored name and the on-disk key in agreement — both derive from the same string.
    async function nfcDedupOnBackend(storageType: 'local' | 'local-key'): Promise<void> {
        const config = createTestMountConfig(`nfc-dedup-${storageType}`, storageType);
        const mount = new Mount('owner', TEST_DIR, config, getLocalDatabase(TEST_DIR));
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const nfd = 'cafe\u0301.txt'; // "cafe.txt" decomposed: e + U+0301
        const nfc = 'caf\u00e9.txt'; // "cafe.txt" composed: U+00E9
        await mount.createFile(rootId, nfd, 'text/plain', 1, Buffer.from('1'));
        await expect(mount.createFile(rootId, nfc, 'text/plain', 1, Buffer.from('2'))).rejects.toThrow(
            /already exists/,
        );

        const cafes = (await mount.listFolder(rootId)).filter((c) => c.name.normalize('NFC') === nfc);
        expect(cafes.length).toBe(1);
        expect(cafes[0].name).toBe(nfc); // stored NFC, not the raw NFD input

        await mount.closeAllDatabases();
    }

    test('NFD + NFC of a name collide as one, stored NFC — path-based (local)', () => nfcDedupOnBackend('local'));
    test('NFD + NFC of a name collide as one, stored NFC — id-based (local-key)', () => nfcDedupOnBackend('local-key'));
});
