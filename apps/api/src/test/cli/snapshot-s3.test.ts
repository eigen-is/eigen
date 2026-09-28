import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { runCli } from '../cli-test-helpers';
import { createS3MountConfig, FaultMount, FaultStorage } from '../fault-storage-helpers';

// ./eigen backup and restore on an install whose drive is an s3 mount, its bucket outside data/.

const OWNER = 'snapshots3owner';
const MOUNT_ID = 'snapshot-s3';
// macOS tar would add AppleDouble members for extended attributes.
const TAR_ENV = { COPYFILE_DISABLE: '1' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const S3_NOTE = 'Files in S3 buckets are not in a snapshot';
const NOT_REPLAYED = 'Pending uploads in the snapshot were not replayed; the snapshot still holds them.';
const MOUNT_DIR = `home/${OWNER}/mounts/${MOUNT_ID}`;

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Install = { dir: string; homeDir: string; bucket: string };

function install(): Install {
    const dir = mkdtempSync(join(tmpdir(), 'eigen-snapshot-s3-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env.production'), 'DOMAIN=eigen.example.org\n', { mode: 0o600 });
    const homeDir = join(dir, 'data/home', OWNER);
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify({ mounts: { [MOUNT_ID]: createS3MountConfig(MOUNT_ID) } }),
    );
    mkdirSync(join(dir, 'snapshots'), { mode: 0o700 });
    return { dir, homeDir, bucket: join(dir, 'bucket') };
}

type Running = { mount: Mount; fault: FaultStorage; stop: () => Promise<void> };

// Eigen running on the install; stop() is the clean shutdown ./eigen backup archives after.
async function start({ homeDir, bucket }: Install): Promise<Running> {
    const closes: Array<() => Promise<void>> = [];
    const getLocalDatabase = async <S extends SchemaType>(config: DatabaseConfig<S>, relativePath: string) => {
        const db = new ManagedDatabase(config, join(homeDir, relativePath));
        await db.open(0);
        closes.push(() => db.close());
        return db;
    };
    const mount = new FaultMount(OWNER, homeDir, createS3MountConfig(MOUNT_ID), getLocalDatabase);
    const fault = new FaultStorage(new LocalStorage(bucket));
    mount.storage = fault;
    await mount.init();
    return {
        mount,
        fault,
        stop: async () => {
            await mount.closeAllDatabases();
            for (const close of closes) await close();
        },
    };
}

async function snapshot(dir: string, ...args: string[]): Promise<string> {
    const result = await runCli(['snapshot', ...args], { cwd: dir, env: TAR_ENV });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(S3_NOTE);
    const name = /snapshots\/(\S+)/.exec(result.stdout)?.[1];
    if (!name) throw new Error(`no snapshot named in: ${result.stdout}`);
    return name;
}

async function restore(dir: string, name: string): Promise<string> {
    const result = await runCli(['restore', name, '--yes'], { cwd: dir, env: TAR_ENV });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(S3_NOTE);
    return result.stdout;
}

function keptAside(dir: string): string {
    const aside = readdirSync(dir).find((file) => file.startsWith('data.pre-restore-'));
    if (!aside) throw new Error('no data.pre-restore-* kept aside');
    return join(dir, aside);
}

// A document database as the upload queue stages it: SQLite, holding one marker row.
function stageMarkerDb(mount: Mount, marker: string): string {
    const stagingPath = mount.uploadQueue!.newStagingPath();
    const db = new Database(stagingPath, { create: true });
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
    db.run('INSERT INTO items (id, data) VALUES (1, ?)', [marker]);
    db.close(true);
    return stagingPath;
}

function markerIn(dbPath: string): string {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.query<{ data: string }, []>('SELECT data FROM items').get()!.data;
    } finally {
        db.close();
    }
}

async function bucketMarker({ dir, bucket }: Install, storageKey: string): Promise<string> {
    const object = join(dir, 'object.db');
    await Bun.write(object, new LocalStorage(bucket).read(storageKey));
    return markerIn(object);
}

describe('Whole-server snapshot of an s3 mount', () => {
    test('a full snapshot holds the mount database and its staged uploads, a light one the database alone', async () => {
        const target = install();
        const eigen = await start(target);
        const rootId = (await eigen.mount.getRootFolder())!.id;
        const fileId = await eigen.mount.createFile(rootId, 'object.txt', 'text/plain', 3, encoder.encode('obj'));
        // A document upload the bucket has not taken when Eigen stops: staged, with its pending row.
        eigen.fault.failNextWrites = 1;
        eigen.mount.uploadQueue!.enqueueStaged(
            await eigen.mount.getStorageKey(fileId),
            stageMarkerDb(eigen.mount, 'pending'),
            true,
        );
        await eigen.mount.drainPendingUploads();
        expect(eigen.mount.pendingUploadCount).toBe(1);
        await eigen.stop();

        const members = async (name: string): Promise<string[]> => {
            const list = Bun.spawnSync(['tar', '-tzf', join(target.dir, 'snapshots', name)]);
            const mountDir = `data/home/${OWNER}/mounts/${MOUNT_ID}/`;
            return decoder
                .decode(list.stdout)
                .split('\n')
                .filter((path) => path.startsWith(mountDir) && !path.endsWith('/'))
                .map((path) => path.slice(mountDir.length).replace(/^staging\/.*/, 'staging/<staged copy>'))
                .filter((path) => !path.startsWith('metadata.db-'))
                .sort();
        };
        // Neither holds the object itself: it is in the bucket.
        expect(await members(await snapshot(target.dir))).toEqual(['metadata.db', 'staging/<staged copy>']);
        expect(await members(await snapshot(target.dir, '--light'))).toEqual(['metadata.db']);
    });

    test('a settings.json that does not parse neither fails a pre-update snapshot nor warns', async () => {
        const target = install();
        writeFileSync(join(target.homeDir, 'settings.json'), '{');
        const result = await runCli(['snapshot', '--pre-update'], { cwd: target.dir, env: TAR_ENV });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain(S3_NOTE);
        expect(existsSync(join(target.dir, '.eigen/last-update'))).toBe(true);
    });

    test('a restore leaves the bucket objects of the data/ it keeps aside as they were', async () => {
        const target = install();
        const first = await start(target);
        const rootId = (await first.mount.getRootFolder())!.id;
        const docId = await first.mount.createFile(rootId, 'ledger.db', 'application/x-sqlite3', 0, undefined);
        const storageKey = await first.mount.getStorageKey(docId);
        // The bucket is slow while Eigen stops for the backup: this upload is still pending in it.
        first.fault.failNextWrites = 1;
        first.mount.uploadQueue!.enqueueStaged(storageKey, stageMarkerDb(first.mount, 'at the snapshot'), true);
        await first.mount.drainPendingUploads();
        expect(first.mount.pendingUploadCount).toBe(1);
        await first.stop();
        const name = await snapshot(target.dir);

        // Eigen starts again, the pending upload lands, and the document is edited after the backup.
        const second = await start(target);
        await second.mount.drainPendingUploads({ flushNow: true });
        second.mount.uploadQueue!.enqueueStaged(storageKey, stageMarkerDb(second.mount, 'after the backup'), true);
        await second.mount.drainPendingUploads({ flushNow: true });
        expect(second.mount.pendingUploadCount).toBe(0);
        await second.stop();

        expect(await restore(target.dir, name)).toContain(NOT_REPLAYED);
        keptAside(target.dir);
        expect(Array.from(new Bun.Glob('data/*/*/mounts/*/staging/*').scanSync(target.dir))).toEqual([]);
        const third = await start(target);
        try {
            await third.mount.drainPendingUploads({ flushNow: true });
            // The kept-aside data/ names the same key; its object has to still hold its bytes.
            expect(await bucketMarker(target, storageKey)).toBe('after the backup');
        } finally {
            await third.stop();
        }
    });

    test('a hand rollback after a restore uploads the pending bytes of the data/ kept aside, and none of the snapshot', async () => {
        const target = install();
        const first = await start(target);
        const rootId = (await first.mount.getRootFolder())!.id;
        const docId = await first.mount.createFile(rootId, 'ledger.db', 'application/x-sqlite3', 0, undefined);
        const storageKey = await first.mount.getStorageKey(docId);
        first.fault.failNextWrites = 1;
        first.mount.uploadQueue!.enqueueStaged(storageKey, stageMarkerDb(first.mount, 'at the snapshot'), true);
        await first.mount.drainPendingUploads();
        await first.stop();
        const name = await snapshot(target.dir);

        // After the backup one edit lands, and the next one is still pending when Eigen stops for the restore.
        const second = await start(target);
        await second.mount.drainPendingUploads({ flushNow: true });
        second.mount.uploadQueue!.enqueueStaged(storageKey, stageMarkerDb(second.mount, 'after the backup'), true);
        await second.mount.drainPendingUploads({ flushNow: true });
        second.fault.failNextWrites = 1;
        second.mount.uploadQueue!.enqueueStaged(
            storageKey,
            stageMarkerDb(second.mount, 'pending at the restore'),
            true,
        );
        await second.mount.drainPendingUploads();
        expect(second.mount.pendingUploadCount).toBe(1);
        await second.stop();

        await restore(target.dir, name);
        const aside = keptAside(target.dir);
        const restored = await start(target);
        try {
            await restored.mount.drainPendingUploads({ flushNow: true });
            expect(await bucketMarker(target, storageKey)).toBe('after the backup');
        } finally {
            await restored.stop();
        }

        // What an operator does by hand with Eigen stopped: mv data data.restored; mv data.pre-restore-* data.
        renameSync(join(target.dir, 'data'), join(target.dir, 'data.restored'));
        renameSync(aside, join(target.dir, 'data'));
        const rolledBack = await start(target);
        try {
            await rolledBack.mount.drainPendingUploads({ flushNow: true });
            expect(rolledBack.mount.pendingUploadCount).toBe(0);
            expect(await bucketMarker(target, storageKey)).toBe('pending at the restore');
        } finally {
            await rolledBack.stop();
        }
    });

    test('a light restore keeps the pending uploads of the data/ it replaces aside with their database', async () => {
        const target = install();
        const first = await start(target);
        const rootId = (await first.mount.getRootFolder())!.id;
        const docId = await first.mount.createFile(rootId, 'ledger.db', 'application/x-sqlite3', 0, undefined);
        const storageKey = await first.mount.getStorageKey(docId);
        first.fault.failNextWrites = 1;
        const atSnapshot = stageMarkerDb(first.mount, 'at the snapshot');
        first.mount.uploadQueue!.enqueueStaged(storageKey, atSnapshot, true);
        await first.mount.drainPendingUploads();
        expect(first.mount.pendingUploadCount).toBe(1);
        await first.stop();
        const name = await snapshot(target.dir, '--light');

        const second = await start(target);
        await second.mount.drainPendingUploads({ flushNow: true });
        second.fault.failNextWrites = 1;
        const pending = stageMarkerDb(second.mount, 'pending at the restore');
        second.mount.uploadQueue!.enqueueStaged(storageKey, pending, true);
        await second.mount.drainPendingUploads();
        expect(second.mount.pendingUploadCount).toBe(1);
        await second.stop();

        const stdout = await restore(target.dir, name);
        expect(stdout).not.toContain(NOT_REPLAYED);
        const aside = keptAside(target.dir);
        expect(existsSync(join(aside, MOUNT_DIR, 'metadata.db'))).toBe(true);
        expect(existsSync(join(aside, MOUNT_DIR, 'staging', basename(pending)))).toBe(true);

        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const restored = await start(target);
        try {
            await restored.mount.drainPendingUploads({ flushNow: true });
            expect(restored.fault.writeCount).toBe(0);
            expect(restored.mount.pendingUploadCount).toBe(0);
            expect(await bucketMarker(target, storageKey)).toBe('at the snapshot');
            expect(
                warn.mock.calls.some(
                    ([line]) => `${line}`.includes(storageKey) && `${line}`.includes(basename(atSnapshot)),
                ),
            ).toBe(true);
        } finally {
            warn.mockRestore();
            await restored.stop();
        }

        // By hand: the light set's files back over the live ones, its staging/ in place of the live one.
        rmSync(join(target.dir, 'data', MOUNT_DIR, 'staging'), { recursive: true });
        for (const path of new Bun.Glob('**').scanSync(aside)) {
            const live = join(target.dir, 'data', path);
            mkdirSync(dirname(live), { recursive: true });
            renameSync(join(aside, path), live);
        }
        const rolledBack = await start(target);
        try {
            await rolledBack.mount.drainPendingUploads({ flushNow: true });
            expect(rolledBack.mount.pendingUploadCount).toBe(0);
            expect(await bucketMarker(target, storageKey)).toBe('pending at the restore');
        } finally {
            await rolledBack.stop();
        }
    });

    test('with no restore, the pending uploads a snapshot was taken with land on the next start', async () => {
        const target = install();
        const first = await start(target);
        const rootId = (await first.mount.getRootFolder())!.id;
        const docId = await first.mount.createFile(rootId, 'ledger.db', 'application/x-sqlite3', 0, undefined);
        const storageKey = await first.mount.getStorageKey(docId);
        first.fault.failNextWrites = 1;
        first.mount.uploadQueue!.enqueueStaged(storageKey, stageMarkerDb(first.mount, 'at the snapshot'), true);
        await first.mount.drainPendingUploads();
        expect(first.mount.pendingUploadCount).toBe(1);
        await first.stop();
        await snapshot(target.dir);

        const second = await start(target);
        try {
            await second.mount.drainPendingUploads({ flushNow: true });
            expect(second.mount.pendingUploadCount).toBe(0);
            expect(await bucketMarker(target, storageKey)).toBe('at the snapshot');
        } finally {
            await second.stop();
        }
    });
});
