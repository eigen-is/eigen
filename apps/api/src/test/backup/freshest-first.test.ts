import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { buildHomeFolderName } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import type { DatabaseConfig } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import {
    countBackingRows,
    createHomeFaultMount,
    type FaultStorage,
    provisionDoc,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import { findOrFail, getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

// The remote half of snapshotHome: an `s3` mount is materialized into the archive's data/ tree by
// path, and wherever local bytes are newer than the stored object — a container database or a plain
// file whose upload is parked mid-outage — the archive takes the local ones.

const STALE_MOUNT_ID = 'backup-s3-stale';
const FULL_MOUNT_ID = 'backup-s3-full';

const docSchema = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
// No snapshot config: a close-time version enqueue would be noise for these tests.
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'backup-freshest-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

let backingRoot: string;
let home: Home;
let staleMount: Mount;
let staleFault: FaultStorage;
let fullMount: Mount;

// The seeded shape of the settled mount, filled in by beforeAll.
let docFolderName: string;
let nestedFileBytes: Uint8Array;
let trashedFileId: string;

// A real, minimal SQLite database at `filePath`, holding one marker row. Staged copies have to be
// SQLite: the upload queue drops one without the magic header as a poisoned payload.
async function writeMarkerDb(filePath: string, marker: string): Promise<Uint8Array> {
    const db = new Database(filePath, { create: true });
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
    db.run('INSERT INTO items (id, data) VALUES (1, ?)', [marker]);
    db.close(true);
    return new Uint8Array(await Bun.file(filePath).arrayBuffer());
}

function readMarkers(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db
            .query('SELECT data FROM items ORDER BY id')
            .all()
            .map((row) => (row as { data: string }).data);
    } finally {
        db.close();
    }
}

async function archiveBytes(folder: string, relPath: string): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(join(folder, relPath)).arrayBuffer());
}

async function snapshot(): Promise<{ manifest: BackupManifest; folder: string }> {
    const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-freshest-'));
    const manifest = await snapshotHome(home, target);
    return { manifest, folder: join(target, buildHomeFolderName(home.user.id)) };
}

beforeAll(async () => {
    const ctx = await getTestContext();
    home = await getHome(ctx.alice.user.id);
    backingRoot = mkdtempSync(join(TEST_DATA_DIR, 'backup-s3-backing-'));

    ({ mount: staleMount, fault: staleFault } = createHomeFaultMount(home, STALE_MOUNT_ID, backingRoot));
    await staleMount.init();
    registerFaultMount(home.drive, staleMount);

    ({ mount: fullMount } = createHomeFaultMount(home, FULL_MOUNT_ID, backingRoot));
    await fullMount.init();
    registerFaultMount(home.drive, fullMount);

    // The settled mount: a plain file at the root, one nested in a folder, a container database,
    // and a trashed file — every row shape the paths-table walk has to materialize.
    const rootId = (await fullMount.getRootFolder())!.id;
    await fullMount.createFile(rootId, 'kept.png', 'image/png', TEST_PNG_BYTES.byteLength, TEST_PNG_BYTES);
    const nestedId = await fullMount.createFolder(rootId, 'Nested');
    nestedFileBytes = new TextEncoder().encode('nested payload');
    await fullMount.createFile(nestedId, 'nested.txt', 'text/plain', nestedFileBytes.byteLength, nestedFileBytes);

    const { containerId, dataDbId } = await provisionDoc(fullMount);
    docFolderName = (await fullMount.getPath(containerId))!.name;
    const managed = await fullMount.createDatabase(docConfig, dataDbId);
    managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
    await settleContainer(fullMount, containerId);

    trashedFileId = await fullMount.createFile(
        rootId,
        'gone.png',
        'image/png',
        TEST_PNG_BYTES.byteLength,
        TEST_PNG_BYTES,
    );
    await fullMount.trashPath(trashedFileId);

    await fullMount.drainPendingUploads({ flushNow: true });
});

// Injections are per-test: a parked write left behind would strand the NEXT test's upload.
afterEach(async () => {
    staleFault.parkWrites = false;
    staleFault.releaseHungWrites();
    await staleFault.landAllRemaining();
    await staleMount.drainPendingUploads({ flushNow: true });
});

afterAll(async () => {
    unregisterFaultMount(home.drive, STALE_MOUNT_ID);
    unregisterFaultMount(home.drive, FULL_MOUNT_ID);
    await staleMount.closeAllDatabases();
    await fullMount.closeAllDatabases();
});

describe('Backup freshest-first on an s3 mount', () => {
    test('a container database whose upload is parked is archived from the staged copy', async () => {
        const { containerId, dataDbId } = await provisionDoc(staleMount);
        const containerName = (await staleMount.getPath(containerId))!.name;
        const managed = await staleMount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'stored' }).run();
        await managed.flush();
        await staleMount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(staleMount, dataDbId, backingRoot)).toBe(1);

        // The outage: the second commit is staged and enqueued, and its PUT never lands. Closing
        // the database first leaves no live handle, so the staged copy is the only fresh source.
        managed.db.insert(docSchema.items).values({ id: 2, data: 'parked' }).run();
        staleFault.parkWrites = true;
        await staleMount.closeDatabase(dataDbId);
        const storageKey = await staleMount.getStorageKey(dataDbId);
        await staleFault.waitForParked((p) => p.key === storageKey);
        expect(await countBackingRows(staleMount, dataDbId, backingRoot)).toBe(1);

        const { manifest, folder } = await snapshot();
        const relPath = `home/mounts/${STALE_MOUNT_ID}/data/${containerName}/data.db`;
        expect(manifest.entries.map((e) => e.path)).toContain(relPath);
        expect(readMarkers(join(folder, relPath))).toEqual(['stored', 'parked']);
        // and the stored object the archive did NOT take is still one commit behind
        expect(await countBackingRows(staleMount, dataDbId, backingRoot)).toBe(1);

        // The staged copy is materialized into data/ where it wins, never archived as a staging/
        // file of its own — nor are the mount's thumbs/ and tmp/ caches.
        const mountPrefix = `home/mounts/${STALE_MOUNT_ID}/`;
        expect(
            manifest.entries
                .map((e) => e.path)
                .filter((p) => p.startsWith(mountPrefix) && !p.startsWith(`${mountPrefix}data/`)),
        ).toEqual([`${mountPrefix}metadata.db`]);
    });

    test('an open container database beats both the staged copy and the stored object', async () => {
        const { containerId, dataDbId } = await provisionDoc(staleMount);
        const containerName = (await staleMount.getPath(containerId))!.name;
        const managed = await staleMount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'acked' }).run();
        await managed.flush();
        await staleMount.drainPendingUploads({ flushNow: true });

        // Three rungs, each one commit apart: the stored object has 'acked', the parked staged copy
        // adds 'staged', and 'live' only ever exists in the open handle. Nothing flushes it, so a
        // capture that settled for the staged copy would silently drop it.
        staleFault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'staged' }).run();
        await managed.flush();
        const storageKey = await staleMount.getStorageKey(dataDbId);
        await staleFault.waitForParked((p) => p.key === storageKey);
        managed.db.insert(docSchema.items).values({ id: 3, data: 'live' }).run();
        expect(await countBackingRows(staleMount, dataDbId, backingRoot)).toBe(1);

        const { manifest, folder } = await snapshot();
        const relPath = `home/mounts/${STALE_MOUNT_ID}/data/${containerName}/data.db`;
        expect(manifest.entries.map((e) => e.path)).toContain(relPath);
        expect(readMarkers(join(folder, relPath))).toEqual(['acked', 'staged', 'live']);
    });

    test('a plain file whose upload is parked is archived from the staged copy', async () => {
        const rootId = (await staleMount.getRootFolder())!.id;
        const scratch = mkdtempSync(join(TEST_DATA_DIR, 'backup-plain-'));
        const storedBytes = await writeMarkerDb(join(scratch, 'stored.db'), 'stored');
        const fileId = await staleMount.createFile(
            rootId,
            'ledger.db',
            'application/x-sqlite3',
            storedBytes.byteLength,
            storedBytes,
        );
        const storageKey = await staleMount.getStorageKey(fileId);

        // A plain file with newer bytes in staging/ and a pending_uploads row, the stored object
        // still holding the old ones — what an outage leaves behind, and what restoring an s3 mount
        // stages for every file before the queue drains it.
        const queue = staleMount.uploadQueue!;
        staleFault.parkWrites = true;
        const stagingPath = queue.newStagingPath();
        const stagedBytes = await writeMarkerDb(stagingPath, 'staged');
        queue.enqueueStaged(storageKey, stagingPath, true);
        await staleFault.waitForParked((p) => p.key === storageKey);

        const { manifest, folder } = await snapshot();
        const relPath = `home/mounts/${STALE_MOUNT_ID}/data/ledger.db`;
        expect(manifest.entries.map((e) => e.path)).toContain(relPath);
        // Byte-identical to the staged copy: a plain file is never rewritten on its way in.
        expect(await archiveBytes(folder, relPath)).toEqual(stagedBytes);
        expect(readMarkers(join(folder, relPath))).toEqual(['staged']);
        // ...and the stored object the archive passed over still holds the old bytes.
        const storedCopy = join(scratch, 'object.db');
        await Bun.write(storedCopy, staleMount.storage.read(storageKey));
        expect(readMarkers(storedCopy)).toEqual(['stored']);
    });

    test('a settled s3 mount is materialized into data/ by path', async () => {
        const { manifest, folder } = await snapshot();
        const prefix = `home/mounts/${FULL_MOUNT_ID}/data/`;
        const archived = manifest.entries
            .map((e) => e.path)
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length))
            .sort();

        expect(archived).toEqual(
            [`${docFolderName}/data.db`, `.trash/${trashedFileId}.png`, 'Nested/nested.txt', 'kept.png'].sort(),
        );
        // Every file row in the paths table, and nothing else.
        expect(archived.length).toBe(await fullMount.getFileCount());

        expect(await archiveBytes(folder, `${prefix}kept.png`)).toEqual(TEST_PNG_BYTES);
        expect(await archiveBytes(folder, `${prefix}Nested/nested.txt`)).toEqual(nestedFileBytes);
        expect(await archiveBytes(folder, `${prefix}.trash/${trashedFileId}.png`)).toEqual(TEST_PNG_BYTES);
        // The container database comes out of the stored object, readable on its own.
        expect(readMarkers(join(folder, `${prefix}${docFolderName}/data.db`))).toEqual(['settled']);

        const summary = findOrFail(manifest.mounts, (m) => m.id === FULL_MOUNT_ID);
        expect(summary.storageType).toBe('s3');
        expect(summary.files).toBe(archived.length);
        expect(summary.bytes).toBeGreaterThan(0);
    });
});
