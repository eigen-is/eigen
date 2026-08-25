import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { S3Storage } from '../../lib/storage/s3-storage';

// Live-S3 suite (audit test-gap 1): pins the network-touching S3Storage surface and the S3-mount
// trash lifecycle against a real S3 — the scripts/s3-local MinIO harness. Opt-in: set
// S3_TEST_ENDPOINT (e.g. http://localhost:9000); unset or unreachable, every test skips.
// The `..`/empty-segment key guards are pinned network-free in storage.test.ts — not repeated here.
const endpoint = process.env['S3_TEST_ENDPOINT'];

const s3Config: S3Config = {
    endpoint: endpoint ?? '',
    bucket: process.env['S3_TEST_BUCKET'] ?? 'eigen',
    accessKeyId: process.env['S3_TEST_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_TEST_SECRET_KEY'] ?? 'minioadmin',
    region: 'eu-west-1',
    // Unique per run so concurrent/aborted runs never collide; afterAll deletes what we created.
    prefix: `test-${randomUUID()}`,
};

// skipIf is evaluated at registration, so the reachability probe runs at module load, not in
// beforeAll. Any HTTP response (MinIO answers 403 on /) proves the endpoint is up.
let live = false;
if (!endpoint) {
    console.info('[s3-minio] S3_TEST_ENDPOINT not set — skipping live S3 tests (see scripts/s3-local)');
} else {
    try {
        await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
        live = true;
    } catch {
        console.warn(`[s3-minio] S3_TEST_ENDPOINT=${endpoint} unreachable — skipping live S3 tests`);
    }
}

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-s3-minio-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, join(baseDir, relativePath));
        await db.open(0);
        return db;
    };
}

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 's3-minio-test-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

// Every object key this run writes (relative to the run prefix), deleted best-effort in afterAll.
const createdKeys: string[] = [];

beforeAll(() => {
    if (live) mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(async () => {
    if (!live) return;
    const cleanup = new S3Storage(s3Config);
    for (const key of createdKeys) {
        await cleanup.delete(key); // best-effort — delete() catches and returns false
    }
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe.skipIf(!live)('S3Storage (MinIO)', () => {
    let storage: S3Storage;

    beforeAll(() => {
        storage = new S3Storage(s3Config);
    });

    test('write and read round-trip byte-identically', async () => {
        const data = Uint8Array.from({ length: 256 }, (_, i) => i);
        createdKeys.push('direct/round-trip.bin');
        const written = await storage.write('direct/round-trip.bin', data);
        expect(written).toBe(256);
        const echoed = new Uint8Array(await storage.read('direct/round-trip.bin').arrayBuffer());
        expect(echoed).toEqual(data);
    });

    test('exists is true for a written key, false for a missing one', async () => {
        createdKeys.push('direct/exists.txt');
        await storage.write('direct/exists.txt', Buffer.from('here'));
        expect(await storage.exists('direct/exists.txt')).toBe(true);
        expect(await storage.exists('direct/never-written.txt')).toBe(false);
    });

    test('readRange returns the exact end-exclusive slice', async () => {
        createdKeys.push('direct/range.txt');
        await storage.write('direct/range.txt', Buffer.from('0123456789'));
        expect(await storage.readRange('direct/range.txt', 2, 6).text()).toBe('2345');
    });

    test('delete returns true once, then exists false, then delete false', async () => {
        createdKeys.push('direct/delete.txt');
        await storage.write('direct/delete.txt', Buffer.from('bye'));
        expect(await storage.delete('direct/delete.txt')).toBe(true);
        expect(await storage.exists('direct/delete.txt')).toBe(false);
        expect(await storage.delete('direct/delete.txt')).toBe(false);
    });

    // Pins the audit item-7 fix: size() goes through stat() — S3File.size is a synchronous NaN.
    test('size returns the byte length', async () => {
        createdKeys.push('direct/sized.txt');
        await storage.write('direct/sized.txt', Buffer.from('12345'));
        expect(await storage.size('direct/sized.txt')).toBe(5);
    });

    test('size returns null for a missing key', async () => {
        expect(await storage.size('direct/no-such-key')).toBeNull();
    });
});

describe.skipIf(!live)('Mount (s3 storage, MinIO)', () => {
    let mount: Mount;
    let rootId: string;

    beforeAll(async () => {
        const config: MountConfig = {
            id: 'test-s3-minio',
            name: 'test-s3-minio',
            storageType: 's3',
            isDefault: false,
            s3Config,
        };
        mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
        await mount.init(); // metadata.db stays local — only file bytes hit MinIO
        rootId = (await mount.getRootFolder())!.id;
    });

    afterAll(async () => {
        // Stops the upload queue's self-scheduled retry timers.
        await mount?.closeAllDatabases();
    });

    test('createFile puts the bytes in S3; readFile returns them', async () => {
        const data = Buffer.from('s3-mount-bytes');
        const fileId = await mount.createFile(rootId, 'round-trip.txt', 'text/plain', data.length, data);
        const storageKey = await mount.getStorageKey(fileId);
        createdKeys.push(storageKey);

        expect(await mount.storage.exists(storageKey)).toBe(true);
        const file = await mount.readFile(fileId);
        expect(new TextDecoder().decode(await file!.arrayBuffer())).toBe('s3-mount-bytes');
    });

    test('trash then restore: content survives', async () => {
        const data = Buffer.from('survives-the-trash');
        const fileId = await mount.createFile(rootId, 'restore-me.txt', 'text/plain', data.length, data);
        createdKeys.push(await mount.getStorageKey(fileId));

        await mount.trashPath(fileId);
        const restored = await mount.restorePath(fileId);
        expect(restored.trashedAt).toBeNull();

        const file = await mount.readFile(fileId);
        expect(new TextDecoder().decode(await file!.arrayBuffer())).toBe('survives-the-trash');
    });

    test('trash then permanent delete: DB row gone and S3 object gone', async () => {
        const data = Buffer.from('gone-for-good');
        const fileId = await mount.createFile(rootId, 'perm-delete.txt', 'text/plain', data.length, data);
        const storageKey = await mount.getStorageKey(fileId); // capture before the row disappears

        await mount.trashPath(fileId);
        await mount.permanentlyDeleteFromTrash(fileId);

        expect(await mount.getPath(fileId)).toBeNull();
        expect(await mount.storage.exists(storageKey)).toBe(false);
    });

    // Managed data.db writes go through the write-behind queue (docs/SYNC.md Phase 1b). Pin its
    // basic ack against a real S3: close enqueues, drain awaits the PUT, the object lands.
    test('write-behind queue acks a managed data.db flush', async () => {
        const containerId = await mount.createFolder(rootId, 'QueueDoc', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        const storageKey = await mount.getStorageKey(dataDbId);
        createdKeys.push(storageKey);

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'acked' }).run();
        await mount.closeDatabase(dataDbId);

        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await mount.storage.exists(storageKey)).toBe(true);
    });
});
