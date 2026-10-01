import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { runHomeBackup, startBackupJob } from '../../lib/backup/jobs';
import { restoreHome } from '../../lib/backup/restore';
import { verifyFolder } from '../../lib/backup/verify';
import { getStorageType, updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import { Mount } from '../../lib/mount/mount';
import {
    assertJson,
    authedRequest,
    chatPost,
    createTestUser,
    driveDelete,
    driveGetList,
    drivePost,
    drivePut,
    driveUpload,
    ensureServer,
    findOrFail,
    type TestUser,
} from '../setup';
import { snapshotInto, waitForJob } from './backup-test-helpers';

const M = 'default';
const REPORTS = [0, 1, 2, 3, 4];

async function raceUser(storageType: 'local-fullnames' | 'local-id'): Promise<TestUser> {
    await ensureServer();
    const before = getStorageType();
    await updateServerSettings({ defaults: { mount: { storageType } } });
    try {
        const user = await createTestUser(`race-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Race');
        await getHome(user.id);
        return user;
    } finally {
        await updateServerSettings({ defaults: { mount: { storageType: before } } });
    }
}

async function seed(user: TestUser) {
    const t = user.sessionToken;
    const root = await assertJson<DrivePath>(await authedRequest(t, `/drive/${user.id}/${M}/root`));
    const projects = await drivePost(t, user.id, M, `folder/${root.id}`, { folderName: 'Projects' });
    for (const i of REPORTS)
        await driveUpload(t, user.id, M, projects.id, new File([`report ${i}`], `report-${i}.txt`));
    const single = await driveUpload(t, user.id, M, root.id, new File(['single'], 'zz-single.txt'));
    const archive = await drivePost(t, user.id, M, `folder/${root.id}`, { folderName: 'Archive' });
    return { root, projects, single, archive };
}

// A document with one saved version, created after seed's files so the capture reaches it after its first plain read.
async function seedDocument(user: TestUser, parentId: string) {
    const t = user.sessionToken;
    const doc = await drivePost(t, user.id, M, `folder/${parentId}/create/doc`, { fileName: 'Plan' });
    const saved = await authedRequest(t, `/drive/${user.id}/${M}/file/${doc.id}/versions/save`, { method: 'POST' });
    expect(saved.status).toBe(200);
    const [version] = await assertJson<DrivePath[]>(
        await authedRequest(t, `/drive/${user.id}/${M}/file/${doc.id}/versions`),
    );
    return { doc, version };
}

async function defaultMount(user: TestUser): Promise<Mount> {
    return findOrFail((await getHome(user.id)).drive.getMounts(), (mount) => mount.id === M);
}

// The user's action starts right before the capture reads its first plain file and runs to its end, or until it
// waits for the tree lock the capture holds: awaiting it there would wait on the capture itself.
function duringCapture(action: () => Promise<unknown>) {
    const readKey = Mount.prototype.readKey;
    const withTreeExclusive = Mount.prototype.withTreeExclusive;
    const queued = Promise.withResolvers<void>();
    let done: Promise<unknown> = Promise.resolve();
    let fired = false;
    const exclusive = spyOn(Mount.prototype, 'withTreeExclusive').mockImplementation(function <T>(
        this: Mount,
        fn: () => Promise<T>,
    ) {
        queued.resolve();
        return withTreeExclusive.bind(this)(fn);
    });
    const read = spyOn(Mount.prototype, 'readKey').mockImplementation(async function (this: Mount, key: string) {
        if (!fired) {
            fired = true;
            done = action();
            await Promise.race([done, queued.promise]);
        }
        return readKey.call(this, key);
    });
    return {
        settled: () => done,
        restore: () => {
            read.mockRestore();
            exclusive.mockRestore();
        },
    };
}

async function captureDuring(user: TestUser, action: () => Promise<unknown>) {
    const race = duringCapture(action);
    try {
        const result = await snapshotInto(await getHome(user.id), 'full');
        await race.settled();
        return result;
    } finally {
        race.restore();
    }
}

function backupJob(user: TestUser) {
    return waitForJob(startBackupJob('backup', user.id, undefined, (s, p) => runHomeBackup(user.id, s, p)).id);
}

async function backupDuring(user: TestUser, action: () => Promise<unknown>) {
    const race = duringCapture(action);
    try {
        const job = await backupJob(user);
        await race.settled();
        return job;
    } finally {
        race.restore();
    }
}

// The archived rows' own paths: the archive holds a file's bytes where its archived row says it is.
function archivedReports(folder: string): string[] {
    const data = join(folder, 'home/mounts', M, 'data');
    return REPORTS.map((i) => readFileSync(join(data, 'Projects', `report-${i}.txt`), 'utf8'));
}

function archivedRow(folder: string, id: string) {
    const db = new Database(join(folder, 'home/mounts', M, 'metadata.db'), { readonly: true });
    try {
        return db
            .query<{ name: string; size: number | null }, [string]>('SELECT name, size FROM paths WHERE id = ?')
            .get(id);
    } finally {
        db.close();
    }
}

const reportBodies = REPORTS.map((i) => `report ${i}`);

describe('a capture on a by-name mount takes a file the user moves meanwhile', () => {
    test('a folder renamed during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { projects } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/rename`, { newName: 'Projects 2026' }),
        );
        expect(archivedRow(folder, projects.id)?.name).toBe('Projects');
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a folder moved during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { projects, archive } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/move`, { targetParentId: archive.id }),
        );
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a file trashed during the capture', async () => {
        const user = await raceUser('local-fullnames');
        const { single } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            driveDelete(user.sessionToken, user.id, M, `path/${single.id}`),
        );
        expect(readFileSync(join(folder, 'home/mounts', M, 'data/zz-single.txt'), 'utf8')).toBe('single');
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a file deleted for good during the capture is left out, row and bytes, and the restored home backs up', async () => {
        const user = await raceUser('local-fullnames');
        const { single } = await seed(user);
        const t = user.sessionToken;
        await driveDelete(t, user.id, M, `path/${single.id}`);
        const job = await backupDuring(user, () => driveDelete(t, user.id, M, `trash/${single.id}`));
        expect(job.state).toBe('done');
        await restoreHome(job.artifact!, user.id, `race-${Date.now()}`);
        expect(await driveGetList(t, user.id, M, 'trash')).toEqual([]);
        expect((await backupJob(user)).state).toBe('done');
    }, 120_000);

    test('a trashed document deleted for good during the capture is left out, row and bytes', async () => {
        const user = await raceUser('local-fullnames');
        const { root } = await seed(user);
        const { doc } = await seedDocument(user, root.id);
        await driveDelete(user.sessionToken, user.id, M, `path/${doc.id}`);
        const { manifest, folder } = await captureDuring(user, () =>
            driveDelete(user.sessionToken, user.id, M, `trash/${doc.id}`),
        );
        expect(archivedRow(folder, doc.id)).toBeNull();
        expect(manifest.entries.some((entry) => entry.path.includes(doc.id))).toBe(false);
        expect(archivedReports(folder)).toEqual(reportBodies);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a version pruned during the capture is left out, and the document size above it is stale', async () => {
        const user = await raceUser('local-fullnames');
        const { root } = await seed(user);
        const { doc, version } = await seedDocument(user, root.id);
        const mount = await defaultMount(user);
        // Reading the document caches its size, which the archived metadata.db copy then carries.
        await mount.getPath(doc.id);
        const { manifest, folder } = await captureDuring(user, () => mount.deletePath(version.id));
        expect(archivedRow(folder, version.id)).toBeNull();
        expect(archivedRow(folder, doc.id)?.size).toBeNull();
        expect(manifest.entries.some((entry) => entry.path.endsWith(`versions/${version.name}`))).toBe(false);
        expect(manifest.entries.some((entry) => entry.path.endsWith('Plan.eigendoc/data.db'))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a closed document whose folder is renamed between its key and its read is captured', async () => {
        const user = await raceUser('local-fullnames');
        const { projects } = await seed(user);
        const { doc } = await seedDocument(user, projects.id);
        const mount = await defaultMount(user);
        const dataDb = findOrFail(await mount.listFolder(doc.id), (child) => child.name === 'data.db');
        await mount.closeDatabase(dataDb.id);
        // The rename runs to its end right after the capture resolved the key, unless the tree lock is held: a granted
        // exclusive starts its body before withTreeExclusive returns, a queued one does not.
        const getStorageKey = Mount.prototype.getStorageKey;
        const withTreeExclusive = Mount.prototype.withTreeExclusive;
        const blocked = Promise.withResolvers<void>();
        let renamed: Promise<unknown> | undefined;
        const exclusive = spyOn(Mount.prototype, 'withTreeExclusive').mockImplementation(function <T>(
            this: Mount,
            fn: () => Promise<T>,
        ) {
            let granted = false;
            const result = withTreeExclusive.bind(this)(() => {
                granted = true;
                return fn();
            });
            if (!granted) blocked.resolve();
            return result;
        });
        const keyOf = spyOn(Mount.prototype, 'getStorageKey').mockImplementation(async function (
            this: Mount,
            pathId: string,
        ) {
            const key = await getStorageKey.call(this, pathId);
            if (pathId === dataDb.id && !renamed) {
                renamed = drivePut(user.sessionToken, user.id, M, `path/${projects.id}/rename`, {
                    newName: 'Projects 2026',
                });
                await Promise.race([renamed, blocked.promise]);
            }
            return key;
        });
        let folder: string;
        try {
            ({ folder } = await snapshotInto(await getHome(user.id), 'full'));
            await renamed;
        } finally {
            keyOf.mockRestore();
            exclusive.mockRestore();
        }
        expect(renamed).toBeDefined();
        expect(existsSync(join(folder, 'home/mounts', M, 'data/Projects/Plan.eigendoc/data.db'))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a large file overwritten in place during its copy is archived whole', async () => {
        const user = await raceUser('local-fullnames');
        const { root } = await seed(user);
        const size = 8 * 1024 * 1024;
        const big = await driveUpload(
            user.sessionToken,
            user.id,
            M,
            root.id,
            new File([new Uint8Array(size)], 'big.bin'),
        );
        const mount = await defaultMount(user);
        const bigKey = await mount.getStorageKey(big.id);
        // The overwrite starts on the next turn of the event loop, so it lands only if the copy gives the loop up.
        const readKey = Mount.prototype.readKey;
        let overwritten: Promise<unknown> | undefined;
        const read = spyOn(Mount.prototype, 'readKey').mockImplementation(async function (this: Mount, key: string) {
            if (key === bigKey && !overwritten) {
                const { promise, resolve } = Promise.withResolvers<unknown>();
                overwritten = promise;
                setImmediate(() => resolve(mount.writeFile(big.id, new Uint8Array(size).fill(1))));
            }
            return readKey.call(this, key);
        });
        let result: Awaited<ReturnType<typeof snapshotInto>>;
        try {
            result = await snapshotInto(await getHome(user.id), 'full');
            await overwritten;
        } finally {
            read.mockRestore();
        }
        const archived = readFileSync(join(result.folder, 'home/mounts', M, 'data/big.bin'));
        expect(archived.byteLength).toBe(size);
        expect(new Set(archived).size).toBe(1);
        const entry = findOrFail(result.manifest.entries, (e) => e.path.endsWith('/data/big.bin'));
        expect(entry.bytes).toBe(archived.byteLength);
    });

    test('a flat-key mount, whose keys a rename does not change, is captured as before', async () => {
        const user = await raceUser('local-id');
        const { projects } = await seed(user);
        const { folder } = await captureDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/rename`, { newName: 'Projects 2026' }),
        );
        expect(archivedReports(folder)).toEqual(reportBodies);
    });

    test('an empty folder moved out of a folder deleted for good during the capture keeps its rows', async () => {
        const user = await raceUser('local-id');
        const { root } = await seed(user);
        const t = user.sessionToken;
        const old = await drivePost(t, user.id, M, `folder/${root.id}`, { folderName: 'Old' });
        const gone = await driveUpload(t, user.id, M, old.id, new File(['gone'], 'gone.txt'));
        const keep = await drivePost(t, user.id, M, `folder/${old.id}`, { folderName: 'Keep' });
        const inner = await drivePost(t, user.id, M, `folder/${keep.id}`, { folderName: 'Inner' });
        // Run whole before the first read: a flat-key mount has no tree lock that could wait on the capture.
        let moved: Promise<unknown> | undefined;
        const readKey = Mount.prototype.readKey;
        const read = spyOn(Mount.prototype, 'readKey').mockImplementation(async function (this: Mount, key: string) {
            moved ??= (async () => {
                await drivePut(t, user.id, M, `path/${keep.id}/move`, { targetParentId: root.id });
                await driveDelete(t, user.id, M, `path/${old.id}`);
                await driveDelete(t, user.id, M, `trash/${old.id}`);
            })();
            await moved;
            return readKey.call(this, key);
        });
        let folder: string;
        try {
            ({ folder } = await snapshotInto(await getHome(user.id), 'full'));
        } finally {
            read.mockRestore();
        }
        expect(archivedRow(folder, gone.id)).toBeNull();
        expect(archivedRow(folder, keep.id)?.name).toBe('Keep');
        expect(archivedRow(folder, inner.id)?.name).toBe('Inner');
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a folder moved during a backup job reads back after the restore', async () => {
        const user = await raceUser('local-fullnames');
        const { projects, archive } = await seed(user);
        const job = await backupDuring(user, () =>
            drivePut(user.sessionToken, user.id, M, `path/${projects.id}/move`, { targetParentId: archive.id }),
        );
        expect(job.state).toBe('done');
        await restoreHome(job.artifact!, user.id, `race-${Date.now()}`);
        const t = user.sessionToken;
        const reports = await driveGetList(t, user.id, M, `folder/${projects.id}`);
        expect(reports.map((report) => report.name).sort()).toEqual(REPORTS.map((i) => `report-${i}.txt`));
        for (const report of reports) {
            const res = await authedRequest(t, `/drive/${user.id}/${M}/file/${report.id}/download`);
            expect(res.status).toBe(200);
        }
    }, 120_000);
});

describe('a file whose stream overwrite is in flight when the capture reaches it', () => {
    for (const storageType of ['local-fullnames', 'local-id'] as const) {
        test(`is archived whole, on ${storageType}`, async () => {
            const user = await raceUser(storageType);
            const { root } = await seed(user);
            const size = 8 * 1024 * 1024;
            const big = await driveUpload(
                user.sessionToken,
                user.id,
                M,
                root.id,
                new File([new Uint8Array(size)], 'big.bin'),
            );
            const home = await getHome(user.id);
            const mount = await defaultMount(user);
            const bigKey = await mount.getStorageKey(big.id);
            const frozen = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            // Frozen where Bun.write's thread is part-way: half of the new bytes over the file.
            const write = mount.storage.write.bind(mount.storage);
            const writeSpy = spyOn(mount.storage, 'write').mockImplementation(async (key, data) => {
                if (key === bigKey) {
                    writeFileSync(mount.storage.getPath!(key), Buffer.alloc(size / 2, 1));
                    frozen.resolve();
                    await release.promise;
                }
                return write(key, data);
            });
            const overwrite = home.drive.writeFileContent(M, big.id, new Blob([new Uint8Array(size).fill(1)]).stream());
            await frozen.promise;
            // The capture's own request for the file's lock lets the overwrite finish.
            const withPathLock = Mount.prototype.withPathLock;
            const lock = spyOn(Mount.prototype, 'withPathLock').mockImplementation(function <T>(
                this: Mount,
                pathId: string,
                fn: () => Promise<T>,
            ) {
                if (pathId === big.id) release.resolve();
                return withPathLock.bind(this)(pathId, fn);
            });
            let result: Awaited<ReturnType<typeof snapshotInto>>;
            try {
                result = await snapshotInto(home, 'full');
            } finally {
                release.resolve();
                await overwrite;
                lock.mockRestore();
                writeSpy.mockRestore();
            }
            const archived = readFileSync(join(result.folder, 'home/mounts', M, 'data/big.bin'));
            expect(archived.byteLength).toBe(size);
            expect(new Set(archived).size).toBe(1);
            const entry = findOrFail(result.manifest.entries, (e) => e.path.endsWith('/data/big.bin'));
            expect(entry.bytes).toBe(size);
            expect((await verifyFolder(result.folder)).status).toBe('verified');
        });
    }
});

describe('a chat whose version is restored during the backup', () => {
    for (const storageType of ['local-fullnames', 'local-id'] as const) {
        test(`reopens with its messages after a restore, on ${storageType}`, async () => {
            const user = await raceUser(storageType);
            const t = user.sessionToken;
            const { root } = await seed(user);
            const chat = await drivePost(t, user.id, M, `folder/${root.id}/create/chat`, { fileName: 'Talk' });
            await chatPost(t, user.id, M, `${chat.id}/messages`, { content: 'v1' });
            const saved = await assertJson<DrivePath>(
                await authedRequest(t, `/drive/${user.id}/${M}/file/${chat.id}/versions/save`, { method: 'POST' }),
            );
            await chatPost(t, user.id, M, `${chat.id}/messages`, { content: 'v2' });
            const job = await backupDuring(user, () =>
                authedRequest(t, `/drive/${user.id}/${M}/file/${chat.id}/versions/${saved.name}/restore`, {
                    method: 'POST',
                }),
            );
            expect(job.state).toBe('done');
            await restoreHome(job.artifact!, user.id, `race-${Date.now()}`);
            const res = await authedRequest(t, `/chat/${user.id}/${M}/${chat.id}/messages`);
            expect(res.status).toBe(200);
            const messages = await assertJson<{ content: string }[]>(res);
            expect(messages.map((message) => message.content)).toContain('v1');
        }, 120_000);
    }
});
