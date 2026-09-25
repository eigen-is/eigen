import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { packFolder } from '../../lib/backup/archive';
import { getBackupJob, runHomeBackup, startBackupJob, withBackupJobSlot } from '../../lib/backup/jobs';
import { buildArtifactName, buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { deleteSafetyCopy } from '../../lib/backup/safety-copy';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import type { DatabaseConfig } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import type { StorageFile } from '../../lib/storage';
import { LocalStorage } from '../../lib/storage/local-storage';
import {
    createHomeFaultMount,
    createS3MountConfig,
    FaultStorage,
    provisionDoc,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import { assertJson, authedRequest, createTestUser, getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

// Per-home backup and restore of an s3 mount whose bucket stalls, refuses PUTs or loses objects.

// Past this, a backup-layer call on storage that stopped answering counts as wedged.
const STALL_BOUND_MS = 3_000;
const STALL_TEST_TIMEOUT_MS = 20_000;
const TEXT_BYTES = new TextEncoder().encode('a plain file on an s3 mount');

const docSchema = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'backup-slow-bucket-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

// A GET whose body never arrives: the object exists, and its stream waits until the test lets go.
class StallingStorage extends FaultStorage {
    readonly stallKeys = new Set<string>();
    private readonly releases: Array<() => void> = [];

    override read(key: string): StorageFile {
        const file = super.read(key);
        if (!this.stallKeys.has(key)) return file;
        const gate = new Promise<void>((resolve) => this.releases.push(resolve));
        return Object.assign(file, {
            stream: () =>
                new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        await gate;
                        controller.close();
                    },
                }),
        });
    }

    releaseStalls(): void {
        this.stallKeys.clear();
        for (const release of this.releases.splice(0)) release();
    }
}

function readMarkers(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db
            .query<{ data: string }, []>('SELECT data FROM items ORDER BY id')
            .all()
            .map((row) => row.data);
    } finally {
        db.close();
    }
}

// A standalone SQLite file with these markers, the shape a document's working copy has on disk.
function writeMarkerDb(filePath: string, markers: string[]): void {
    const db = new Database(filePath, { create: true });
    db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)');
    for (const [index, marker] of markers.entries()) {
        db.run('INSERT INTO items (id, data) VALUES (?, ?)', [index + 1, marker]);
    }
    db.close(true);
}

async function waitForJobEnd(jobId: string, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (getBackupJob(jobId)?.state === 'running' && Date.now() < deadline) await Bun.sleep(25);
    return getBackupJob(jobId)?.state;
}

describe('Backup of an s3 mount whose bucket stalls or loses objects', () => {
    let home: Home;
    let backingRoot: string;

    beforeAll(async () => {
        await getTestContext();
        // A home of its own: every test here walks the whole home.
        const user = await createTestUser('backup-slow-bucket@test.eigen.is', 'testpassword123', 'Slow Bucket');
        home = await getHome(user.id);
        backingRoot = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-backing-'));
    });

    afterAll(() => {
        rmSync(backingRoot, { recursive: true, force: true });
    });

    // Gap BK-3: a bucket that no longer holds a mount's objects yields a backup that verifies with none of them.
    test.failing(
        'a mount whose objects are gone from the bucket fails the backup',
        async () => {
            const mountId = 'slow-bucket-gone';
            const { mount } = createHomeFaultMount(home, mountId, backingRoot);
            await mount.init();
            registerFaultMount(home.drive, mount);
            try {
                const rootId = (await mount.getRootFolder())!.id;
                await mount.createFile(rootId, 'photo.png', 'image/png', TEST_PNG_BYTES.byteLength, TEST_PNG_BYTES);
                await mount.createFile(rootId, 'notes.txt', 'text/plain', TEXT_BYTES.byteLength, TEXT_BYTES);
                // The bucket is deleted, emptied or renamed: every HEAD answers 404 while the rows stay.
                rmSync(join(backingRoot, mountId), { recursive: true, force: true });

                const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-gone-'));
                await expect(snapshotHome(home, target)).rejects.toThrow(mountId);
            } finally {
                unregisterFaultMount(home.drive, mountId);
                await mount.closeAllDatabases();
            }
        },
        STALL_TEST_TIMEOUT_MS,
    );

    // Gap BK-4: a GET that never answers holds the backup job, and with it the home's one job slot.
    test.failing(
        'a GET that never answers ends the backup job, so the home can be restored again',
        async () => {
            const mountId = 'slow-bucket-get';
            const { mount } = createHomeFaultMount(home, mountId, backingRoot);
            const storage = new StallingStorage(new LocalStorage(join(backingRoot, mountId)));
            mount.storage = storage;
            await mount.init();
            registerFaultMount(home.drive, mount);
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
                storage.stallKeys.add(await mount.getStorageKey(fileId));

                const job = startBackupJob('backup', home.user.id, home.user.id, (started, onProgress) =>
                    runHomeBackup(home, started, onProgress),
                );
                jobId = job.id;
                expect(await waitForJobEnd(job.id, STALL_BOUND_MS)).toBe('failed');
            } finally {
                storage.releaseStalls();
                if (jobId) {
                    await waitForJobEnd(jobId, STALL_TEST_TIMEOUT_MS / 2);
                    const artifact = getBackupJob(jobId)?.artifact;
                    if (artifact) {
                        rmSync(join(getBackupsDir(), artifact), { force: true });
                        rmSync(join(getBackupsDir(), `${artifact}.manifest.json`), { force: true });
                    }
                }
                unregisterFaultMount(home.drive, mountId);
                await mount.closeAllDatabases();
            }
        },
        STALL_TEST_TIMEOUT_MS,
    );

    // Gap BK-5: freshest-first never looks at the crash temp an unclean shutdown leaves behind.
    test.failing(
        'a document whose last edits survive only in its crash temp is archived with them',
        async () => {
            const mountId = 'slow-bucket-crash';
            const { mount } = createHomeFaultMount(home, mountId, backingRoot);
            await mount.init();
            registerFaultMount(home.drive, mount);
            try {
                const { containerId, dataDbId } = await provisionDoc(mount);
                const containerName = (await mount.getPath(containerId))!.name;
                const managed = await mount.createDatabase(docConfig, dataDbId);
                managed.db.insert(docSchema.items).values({ id: 1, data: 'settled' }).run();
                await settleContainer(mount, containerId);

                // What a SIGKILL leaves: tmp/ holds a commit the bucket never got, which the next open adopts.
                writeMarkerDb(mount.getTempPath(dataDbId), ['settled', 'crash tail']);

                const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-crash-'));
                await snapshotHome(home, target);
                const archived = join(
                    target,
                    buildHomeFolderName(home.user.id),
                    `home/mounts/${mountId}/data/${containerName}/data.db`,
                );
                expect(readMarkers(archived)).toEqual(['settled', 'crash tail']);
            } finally {
                unregisterFaultMount(home.drive, mountId);
                await mount.closeAllDatabases();
            }
        },
        STALL_TEST_TIMEOUT_MS,
    );
});

describe('Backup safety-copy delete on a bucket that never answers', () => {
    // Gap BK-4: a HEAD that never answers holds the delete, and with it the home's one job slot.
    test.failing(
        'a delete against a bucket that never answers gives the home slot back',
        async () => {
            // Accepts every connection and never says a word: a black-holed endpoint.
            const hole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
            const parent = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-safety-'));
            const homeName = 'slowbucketsafetyowner';
            const homeDir = join(parent, homeName);
            const copy = join(parent, `${homeName}${PRE_RESTORE_SUFFIX}20260101-000000`);
            const mountId = 'slow-bucket-safety';
            for (const [dir, rows] of [
                [homeDir, []],
                [copy, [['only-in-copy', 'only-in-copy.png']]],
            ] as const) {
                mkdirSync(join(dir, 'mounts', mountId), { recursive: true });
                const db = new Database(join(dir, 'mounts', mountId, 'metadata.db'), { create: true });
                db.run('CREATE TABLE paths (id TEXT, file TEXT, type TEXT)');
                for (const [id, file] of rows) db.run("INSERT INTO paths VALUES (?, ?, 'file')", [id, file]);
                db.close();
            }
            writeFileSync(
                join(copy, 'settings.json'),
                JSON.stringify({
                    mounts: {
                        [mountId]: {
                            storageType: 's3',
                            s3Config: {
                                ...createS3MountConfig(mountId).s3Config,
                                endpoint: `http://127.0.0.1:${hole.port}`,
                            },
                        },
                    },
                }),
            );

            const deleting = withBackupJobSlot(homeName, () => deleteSafetyCopy(copy, homeDir));
            try {
                const outcome = await Promise.race([
                    deleting.then(
                        () => 'deleted',
                        () => 'refused',
                    ),
                    Bun.sleep(STALL_BOUND_MS).then(() => 'pending'),
                ]);
                expect(outcome).toBe('refused');
            } finally {
                hole.stop(true);
                await deleting.catch(() => {});
                rmSync(parent, { recursive: true, force: true });
            }
        },
        STALL_TEST_TIMEOUT_MS,
    );
});

describe('Backup restore of an s3 mount onto a bucket that takes no PUTs', () => {
    const mountId = 'slow-bucket-restore';
    let userId: string;
    let token: string;
    let backing: string;
    let artifact: string;
    let pngId: string;
    let textId: string;

    beforeAll(async () => {
        await getTestContext();
        ({ id: userId, sessionToken: token } = await createTestUser(
            'backup-slow-bucket-restore@test.eigen.is',
            'testpassword123',
            'Slow Bucket Restore',
        ));
        backing = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-restore-backing-'));
        const home = await getHome(userId);
        const { mount } = createHomeFaultMount(home, mountId, backing);
        await mount.init();
        registerFaultMount(home.drive, mount);
        const root = await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${mountId}/root`));
        pngId = await mount.createFile(root.id, 'photo.png', 'image/png', TEST_PNG_BYTES.byteLength, TEST_PNG_BYTES);
        textId = await mount.createFile(root.id, 'notes.txt', 'text/plain', TEXT_BYTES.byteLength, TEXT_BYTES);

        const staging = mkdtempSync(join(TEST_DATA_DIR, 'backup-slow-bucket-restore-'));
        await snapshotHome(home, staging);
        artifact = buildArtifactName(userId, new Date());
        await packFolder(join(staging, buildHomeFolderName(userId)), join(getBackupsDir(), artifact));
        rmSync(staging, { recursive: true, force: true });
        unregisterFaultMount(home.drive, mountId);
        await mount.closeAllDatabases();
        // Restored onto an empty bucket, so only the queue can put the bytes back.
        rmSync(join(backing, mountId), { recursive: true, force: true });
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
        rmSync(backing, { recursive: true, force: true });
    });

    // The restored home's mount over the restored metadata.db, as a (re)start opens it.
    async function openRestoredMount(): Promise<{ mount: Mount; fault: FaultStorage }> {
        const home = await getHome(userId);
        const { mount, fault } = createHomeFaultMount(home, mountId, backing);
        return { mount, fault };
    }

    async function bucketBytes(mount: Mount, pathId: string): Promise<Uint8Array | null> {
        const file = mount.storage.read(await mount.getStorageKey(pathId));
        if (!(await file.exists())) return null;
        return new Uint8Array(await file.arrayBuffer());
    }

    test('the restore finishes without the bucket, serves its files, and lands them after a restart', async () => {
        await restoreHome(artifact, userId, `slow-bucket-restore-${Date.now()}`);

        const { mount: first, fault } = await openRestoredMount();
        fault.parkWrites = true;
        await first.init();
        try {
            await fault.waitForParked(() => true);
            // Served from the staged copies while no PUT has landed.
            expect(new Uint8Array(await (await first.readFile(pngId))!.arrayBuffer())).toEqual(TEST_PNG_BYTES);
            expect(await bucketBytes(first, pngId)).toBeNull();
        } finally {
            // The process dies with its PUTs on the wire: none of them lands.
            await first.closeAllDatabases();
            for (const parked of fault.parked) if (!parked.landed) parked.respond();
        }

        const { mount: second } = await openRestoredMount();
        await second.init();
        try {
            await second.drainPendingUploads({ flushNow: true });
            expect(second.pendingUploadCount).toBe(0);
            expect(await bucketBytes(second, pngId)).toEqual(TEST_PNG_BYTES);
            expect(await bucketBytes(second, textId)).toEqual(TEXT_BYTES);
        } finally {
            await second.closeAllDatabases();
        }
    });

    test('a restore that failed midway runs again from the same artifact', async () => {
        await expect(
            restoreHome(artifact, userId, `slow-bucket-restore-fail-${Date.now()}`, (step) => {
                if (step === 'mounts') throw new Error('interrupted mid-install');
            }),
        ).rejects.toThrow('interrupted mid-install');

        await restoreHome(artifact, userId, `slow-bucket-restore-again-${Date.now()}`);
        const { mount } = await openRestoredMount();
        await mount.init();
        try {
            await mount.drainPendingUploads({ flushNow: true });
            expect(mount.pendingUploadCount).toBe(0);
            expect(await bucketBytes(mount, pngId)).toEqual(TEST_PNG_BYTES);
            expect(await bucketBytes(mount, textId)).toEqual(TEXT_BYTES);
        } finally {
            await mount.closeAllDatabases();
        }
    });
});
