import { constants, Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drainBackupJobs, getBackupJob, runHomeBackup, startBackupJob } from '../../lib/backup/jobs';
import { buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import type { DatabaseConfig } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import type { Mount } from '../../lib/mount/mount';
import { STORAGE_TIMEOUT_MS, setStorageTimeoutMs } from '../../lib/storage/deadline';
import { LocalStorage } from '../../lib/storage/local-storage';
import { FakeS3Server } from '../fake-s3-server';
import {
    countBackingRows,
    createHomeFaultMount,
    createS3MountConfig,
    FaultMount,
    type FaultStorage,
    provisionDoc,
    registerFaultMount,
    SETTLE_BOUND_MS,
    SHRUNK_STORAGE_TIMEOUT_MS,
    settleContainer,
    settlesWithin,
    unregisterFaultMount,
    waitFor,
} from '../fault-storage-helpers';
import { createTestUser, findOrFail, getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

// The remote half of snapshotHome: an `s3` mount is materialized into the archive's data/ tree by
// path, and wherever local bytes are newer than the stored object — a container database or a plain
// file whose upload is parked mid-outage — the archive takes the local ones.

const STALE_MOUNT_ID = 'backup-s3-stale';
const FULL_MOUNT_ID = 'backup-s3-full';
const STALLED_MOUNT_ID = 'backup-s3-stalled';
const FAILING_MOUNT_ID = 'backup-s3-failing';
const FAILING_CONTAINER_MOUNT_ID = 'backup-s3-failing-container';
const RACING_DELETE_MOUNT_ID = 'backup-s3-racing-delete';
const VANISHING_OBJECT_MOUNT_ID = 'backup-s3-vanishing-object';
const LOCAL_MOUNT_ID = 'backup-local';

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

// A real, minimal SQLite database at `filePath`, one row per marker. Staged copies have to be
// SQLite: the upload queue drops one without the magic header as a poisoned payload.
async function writeMarkerDb(filePath: string, ...markers: string[]): Promise<Uint8Array> {
    const db = new Database(filePath, { create: true });
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
    for (const [index, marker] of markers.entries()) {
        db.run('INSERT INTO items (id, data) VALUES (?, ?)', [index + 1, marker]);
    }
    db.close(true);
    return new Uint8Array(await Bun.file(filePath).arrayBuffer());
}

// What a SIGKILL leaves: a WAL-mode database whose markers sit only in its -wal. The writer stays
// open, since closing it would checkpoint the tail into the main file; the caller closes it.
function writeWalTailDb(filePath: string, ...markers: string[]): Database {
    const db = new Database(filePath, { create: true });
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA wal_autocheckpoint=0');
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
    for (const [index, marker] of markers.entries()) {
        db.run('INSERT INTO items (id, data) VALUES (?, ?)', [index + 1, marker]);
    }
    return db;
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

// An s3 mount whose real S3Storage talks to a FakeS3Server, in the home for the length of `run`.
async function withFakeS3Mount(id: string, run: (mount: Mount, fake: FakeS3Server) => Promise<void>): Promise<void> {
    const fake = new FakeS3Server(new LocalStorage(join(backingRoot, id)));
    const mount = new FaultMount(
        home.user.id,
        home.homeDir,
        { ...createS3MountConfig(id), s3Config: await fake.start() },
        home.getLocalDatabase.bind(home),
    );
    await mount.init();
    registerFaultMount(home.drive, mount);
    try {
        await run(mount, fake);
    } finally {
        fake.heal();
        unregisterFaultMount(home.drive, id);
        await mount.closeAllDatabases();
        await fake.stop();
    }
}

async function snapshot(): Promise<{ manifest: BackupManifest; folder: string }> {
    const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-freshest-'));
    const manifest = await snapshotHome(home, target);
    return { manifest, folder: join(target, buildHomeFolderName(home.user.id)) };
}

// A settled document whose working copy in tmp/ holds one more commit, uncheckpointed, than its stored object.
async function expectWalTailArchived(mount: Mount): Promise<void> {
    const { containerId, dataDbId } = await provisionDoc(mount);
    const containerName = (await mount.getPath(containerId))!.name;
    const managed = await mount.createDatabase(docConfig, dataDbId);
    managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
    await settleContainer(mount, containerId);
    const temp = mount.getTempPath(dataDbId);
    const writer = writeWalTailDb(temp, 'settled', 'crash tail');
    try {
        expect(statSync(`${temp}-wal`).size).toBeGreaterThan(0);
        const { folder } = await snapshot();
        const archived = join(folder, `home/mounts/${mount.id}/data/${containerName}/data.db`);
        expect(readMarkers(archived)).toEqual(['settled', 'crash tail']);
    } finally {
        writer.close();
        await mount.deletePath(containerId);
    }
}

beforeAll(async () => {
    await getTestContext();
    // A home of its own: every snapshot below walks the whole home, and alice's has by now
    // collected what every earlier test file left in it — seconds per walk on CI, times the eight
    // snapshots the storage-failure test takes.
    const user = await createTestUser('backup-freshest@test.eigen.is', 'testpassword123', 'Backup Freshest');
    home = await getHome(user.id);
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
        // file of its own — nor is the mount's tmp/ cache. (thumbs/ IS archived, but this mount has
        // none: its files were created straight on the mount, never through the upload route that
        // writes one.)
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

    // A backup must never silently omit a mount's objects, so an unreadable one fails the whole job.
    // Bun's S3Error says only "an unexpected error has occurred" and puts the actionable part in
    // `code`, which is all the admin pane's one-line job error would otherwise have shown.
    test('a storage failure fails the snapshot, naming the mount, the code and the object', async () => {
        await withFakeS3Mount(FAILING_MOUNT_ID, async (mount, fake) => {
            const rootId = (await mount.getRootFolder())!.id;
            const fileId = await mount.createFile(
                rootId,
                'unreachable.png',
                'image/png',
                TEST_PNG_BYTES.byteLength,
                TEST_PNG_BYTES,
            );
            const storageKey = await mount.getStorageKey(fileId);
            // The HEAD fails, then only the GET: each keeps the code the provider answered with.
            fake.faults.set(storageKey, 'fail');
            await expect(snapshot()).rejects.toThrow(
                `mount ${FAILING_MOUNT_ID}: storage unreachable (UnknownError) reading ${storageKey}`,
            );
            fake.faults.set(storageKey, 'fail-get');
            await expect(snapshot()).rejects.toThrow(
                `mount ${FAILING_MOUNT_ID}: storage unreachable (InternalError) reading ${storageKey}`,
            );
        });
    });

    // The container branch used to name the archive path instead of the object it could not read,
    // which is the one thing an admin chasing a bucket failure needs.
    test('a container database that cannot be read names its storage key', async () => {
        await withFakeS3Mount(FAILING_CONTAINER_MOUNT_ID, async (mount, fake) => {
            const { containerId, dataDbId } = await provisionDoc(mount);
            const managed = await mount.createDatabase(docConfig, dataDbId);
            managed.db.insert(docSchema.items).values({ id: 1, data: 'stored' }).run();
            // No live handle and nothing staged, so the copy has to go to the stored object.
            await settleContainer(mount, containerId);
            const storageKey = await mount.getStorageKey(dataDbId);
            fake.faults.set(storageKey, 'fail-get');
            await expect(snapshot()).rejects.toThrow(
                `mount ${FAILING_CONTAINER_MOUNT_ID}: storage unreachable (InternalError) reading ${storageKey}`,
            );
        });
    });

    // A failure on THIS machine keeps its own errno: calling it "storage unreachable" would send the
    // admin after the wrong box.
    test.skipIf(process.getuid?.() === 0)(
        'an unreadable local copy fails the snapshot with its own errno',
        async () => {
            const rootId = (await staleMount.getRootFolder())!.id;
            const fileId = await staleMount.createFile(
                rootId,
                'locked.bin',
                'application/octet-stream',
                4,
                new Uint8Array(4),
            );
            const storageKey = await staleMount.getStorageKey(fileId);
            const queue = staleMount.uploadQueue!;
            staleFault.parkWrites = true;
            const stagingPath = queue.newStagingPath();
            await Bun.write(stagingPath, new Uint8Array(4).fill(1));
            queue.enqueueStaged(storageKey, stagingPath, false);
            await staleFault.waitForParked((p) => p.key === storageKey);
            chmodSync(stagingPath, 0);
            try {
                await expect(snapshot()).rejects.toThrow('EACCES: permission denied');
            } finally {
                chmodSync(stagingPath, 0o644);
            }
        },
    );

    test('a plain file whose object is gone from the bucket fails the backup', async () => {
        const rootId = (await staleMount.getRootFolder())!.id;
        const fileId = await staleMount.createFile(
            rootId,
            'lost.png',
            'image/png',
            TEST_PNG_BYTES.byteLength,
            TEST_PNG_BYTES,
        );
        const storageKey = await staleMount.getStorageKey(fileId);
        try {
            await staleFault.inner.delete(storageKey);
            await expect(snapshot()).rejects.toThrow(
                `mount ${STALE_MOUNT_ID}: lost.png has ${TEST_PNG_BYTES.byteLength} bytes on record but no object at ${storageKey}`,
            );
        } finally {
            await staleMount.deletePath(fileId);
        }
    });

    test('a file with no object passes when it has no bytes on record or is deleted mid-walk', async () => {
        const rootId = (await staleMount.getRootFolder())!.id;
        const touchedId = await staleMount.touchFile(rootId, 'touched.txt', 'text/plain');
        const deletedId = await staleMount.createFile(
            rootId,
            'deleted.png',
            'image/png',
            TEST_PNG_BYTES.byteLength,
            TEST_PNG_BYTES,
        );
        const deletedKey = await staleMount.getStorageKey(deletedId);
        await staleFault.inner.delete(deletedKey);
        // The row goes after the tree read and before the backup judges the missing object.
        const readKey = staleMount.readKey.bind(staleMount);
        const spy = spyOn(staleMount, 'readKey').mockImplementation(async (key) => {
            const file = await readKey(key);
            if (key === deletedKey) await staleMount.deletePath(deletedId);
            return file;
        });
        try {
            const { manifest } = await snapshot();
            const paths = manifest.entries.map((e) => e.path);
            expect(paths).not.toContain(`home/mounts/${STALE_MOUNT_ID}/data/touched.txt`);
            expect(paths).not.toContain(`home/mounts/${STALE_MOUNT_ID}/data/deleted.png`);
        } finally {
            spy.mockRestore();
            await staleMount.deletePath(touchedId);
            await staleMount.deletePath(deletedId);
        }
    });

    // The object goes after readKey's HEAD answered 200, so the GET that captures it answers NoSuchKey.
    async function snapshotWithObjectGoneAfterHead(
        mount: Mount,
        fileId: string,
        removeObject: () => Promise<unknown>,
    ): Promise<{ manifest: BackupManifest; folder: string }> {
        const storageKey = await mount.getStorageKey(fileId);
        const readKey = mount.readKey.bind(mount);
        const spy = spyOn(mount, 'readKey').mockImplementation(async (key) => {
            const file = await readKey(key);
            if (key === storageKey) await removeObject();
            return file;
        });
        try {
            return await snapshot();
        } finally {
            spy.mockRestore();
        }
    }

    test('a file deleted between the HEAD and the GET drops out of the archive', async () => {
        await withFakeS3Mount(RACING_DELETE_MOUNT_ID, async (mount) => {
            const rootId = (await mount.getRootFolder())!.id;
            const fileId = await mount.createFile(
                rootId,
                'raced.png',
                'image/png',
                TEST_PNG_BYTES.byteLength,
                TEST_PNG_BYTES,
            );
            const { manifest, folder } = await snapshotWithObjectGoneAfterHead(mount, fileId, () =>
                mount.deletePath(fileId),
            );
            const relPath = `home/mounts/${RACING_DELETE_MOUNT_ID}/data/raced.png`;
            expect(manifest.entries.map((e) => e.path)).not.toContain(relPath);
            expect(existsSync(join(folder, relPath))).toBe(false);
        });
    });

    test('a live file whose object vanishes between the HEAD and the GET fails the backup', async () => {
        await withFakeS3Mount(VANISHING_OBJECT_MOUNT_ID, async (mount, fake) => {
            const rootId = (await mount.getRootFolder())!.id;
            const fileId = await mount.createFile(
                rootId,
                'lost.png',
                'image/png',
                TEST_PNG_BYTES.byteLength,
                TEST_PNG_BYTES,
            );
            const storageKey = await mount.getStorageKey(fileId);
            await expect(
                snapshotWithObjectGoneAfterHead(mount, fileId, () => fake.store.delete(storageKey)),
            ).rejects.toThrow(
                `mount ${VANISHING_OBJECT_MOUNT_ID}: storage unreachable (NoSuchKey) reading ${storageKey}`,
            );
        });
    });

    test('a document whose last edits survive only in its crash temp is archived with them', async () => {
        const { containerId, dataDbId } = await provisionDoc(staleMount);
        const containerName = (await staleMount.getPath(containerId))!.name;
        const managed = await staleMount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
        await settleContainer(staleMount, containerId);
        try {
            // What a SIGKILL leaves: tmp/ holds a commit the bucket never got, which the next open adopts.
            await writeMarkerDb(staleMount.getTempPath(dataDbId), 'settled', 'crash tail');
            const { folder } = await snapshot();
            const relPath = `home/mounts/${STALE_MOUNT_ID}/data/${containerName}/data.db`;
            expect(readMarkers(join(folder, relPath))).toEqual(['settled', 'crash tail']);
        } finally {
            await staleMount.deletePath(containerId);
        }
    });

    test('a crash temp whose last edits sit in an uncheckpointed WAL tail is archived with them', async () => {
        await expectWalTailArchived(staleMount);
    });

    // What a failed final sync leaves: a WAL-mode main file with no -wal or -shm, which a readonly open cannot read.
    test('a crash temp with no WAL sidecars is archived with its last edits', async () => {
        const { containerId, dataDbId } = await provisionDoc(staleMount);
        const containerName = (await staleMount.getPath(containerId))!.name;
        const managed = await staleMount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
        await settleContainer(staleMount, containerId);
        try {
            const temp = staleMount.getTempPath(dataDbId);
            const writer = writeWalTailDb(temp, 'settled', 'unsynced');
            writer.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
            writer.close(true);
            expect(existsSync(`${temp}-wal`)).toBe(false);
            expect(existsSync(`${temp}-shm`)).toBe(false);
            const { folder } = await snapshot();
            const relPath = `home/mounts/${STALE_MOUNT_ID}/data/${containerName}/data.db`;
            expect(readMarkers(join(folder, relPath))).toEqual(['settled', 'unsynced']);
        } finally {
            await staleMount.deletePath(containerId);
        }
    });

    // What a SIGKILL during create leaves; the next open discards it, so the backup does too.
    test('a 0-byte crash temp is skipped and the stored object archived', async () => {
        const { containerId, dataDbId } = await provisionDoc(staleMount);
        const containerName = (await staleMount.getPath(containerId))!.name;
        const managed = await staleMount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
        await settleContainer(staleMount, containerId);
        try {
            writeFileSync(staleMount.getTempPath(dataDbId), '');
            const { folder } = await snapshot();
            const relPath = `home/mounts/${STALE_MOUNT_ID}/data/${containerName}/data.db`;
            expect(readMarkers(join(folder, relPath))).toEqual(['settled']);
        } finally {
            await staleMount.deletePath(containerId);
        }
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

describe('Backup freshest-first on a local mount', () => {
    // The test server's default mount is local-id, which keeps no working copy in tmp/.
    let localMount: Mount;
    beforeAll(async () => {
        const settings = await home.settings.set({
            mounts: { [LOCAL_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Local' } },
        });
        await home.drive.addMount(createMountConfig(LOCAL_MOUNT_ID, settings.mounts![LOCAL_MOUNT_ID]));
        localMount = findOrFail(home.drive.getMounts(), (m) => m.id === LOCAL_MOUNT_ID);
    });

    test('a crash temp whose last edits sit in an uncheckpointed WAL tail is archived with them', async () => {
        await expectWalTailArchived(localMount);
    });
});

describe('Backup job on an s3 mount whose bucket stalls', () => {
    test('a GET that stalls ends the backup job, so the home can be restored again', async () => {
        await withFakeS3Mount(STALLED_MOUNT_ID, async (mount, fake) => {
            let jobId: string | undefined;
            try {
                const rootId = (await mount.getRootFolder())!.id;
                const fileId = await mount.createFile(
                    rootId,
                    'stalled.png',
                    'image/png',
                    TEST_PNG_BYTES.byteLength,
                    TEST_PNG_BYTES,
                );
                const storageKey = await mount.getStorageKey(fileId);
                fake.faults.set(storageKey, 'stall-body');
                setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS);
                jobId = startBackupJob('backup', home.user.id, home.user.id, (job, onProgress) =>
                    runHomeBackup(home, job, onProgress),
                ).id;
                await waitFor(() => fake.gets.has(storageKey), 10_000);
                expect(await settlesWithin([drainBackupJobs()], SETTLE_BOUND_MS)).toBe(true);
                expect(getBackupJob(jobId)?.state).toBe('failed');
            } finally {
                setStorageTimeoutMs(STORAGE_TIMEOUT_MS);
                fake.heal();
                await drainBackupJobs();
                const artifact = jobId && getBackupJob(jobId)?.artifact;
                if (artifact) {
                    rmSync(join(getBackupsDir(), artifact), { force: true });
                    rmSync(join(getBackupsDir(), `${artifact}.manifest.json`), { force: true });
                }
            }
        });
    }, 20_000);
});
