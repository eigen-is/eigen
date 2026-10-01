import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { listArtifacts } from '../../lib/backup/artifacts';
import { runHomeBackup, startBackupJob } from '../../lib/backup/jobs';
import { restoreHome } from '../../lib/backup/restore';
import { verifyFolder } from '../../lib/backup/verify';
import { PATHS } from '../../lib/core';
import type { Home } from '../../lib/home';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import type { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { saveThumbnail } from '../../lib/shared/thumbnails';
import { deleteUserCompletely } from '../../lib/user/delete-user';
import {
    assertJson,
    authedRequest,
    createTestUser,
    drivePost,
    driveUpload,
    findOrFail,
    getTestContext,
    TEST_PNG_BYTES,
    type TestUser,
} from '../setup';
import { snapshotInto, waitForJob } from './backup-test-helpers';

// A home with damaged rows or a lost file is archived with a cleaned table and warnings that name them, and an archive
// of a store that holds no object at all fails the home: an empty store is an outage, not a store with holes.

const ORPHAN_WARNING = "entries that do not reach the drive's root, left out:";
const LOST_WARNING = 'files with no object in storage, archived without their bytes:';

// Every home here is broken on purpose, and a whole-server backup in a later file would fail or warn on it.
const created: string[] = [];

afterAll(async () => {
    for (const id of created) await deleteUserCompletely(id, null);
});

async function newUser(label: string): Promise<{ user: TestUser; home: Home; mountId: string; mount: Mount }> {
    const user = await createTestUser(`backup-${label}-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', label);
    created.push(user.id);
    const home = await getHome(user.id);
    const [{ id: mountId }] = await assertJson<{ id: string }[]>(
        await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
    );
    return { user, home, mountId, mount: findOrFail(home.drive.getMounts(), (m) => m.id === mountId) };
}

async function rootOf(user: TestUser, mountId: string): Promise<DrivePath> {
    return assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`));
}

function upload(user: TestUser, mountId: string, parentId: string, name: string, body: BlobPart) {
    return driveUpload<DrivePath>(user.sessionToken, user.id, mountId, parentId, new File([body], name));
}

function metadataPath(homeDir: string, mountId: string): string {
    return join(homeDir, PATHS.DRIVE.ROOT, mountId, PATHS.DRIVE.METADATA_DB);
}

// What a salvaged database or a hand edit in the sqlite3 CLI leaves: a write with foreign keys off.
function writeWithoutForeignKeys(homeDir: string, mountId: string, statements: [string, string[]][]): void {
    const db = new Database(metadataPath(homeDir, mountId));
    try {
        db.run('PRAGMA foreign_keys = OFF');
        for (const [sql, params] of statements) db.run(sql, params);
    } finally {
        db.close();
    }
}

function rowIds(dbPath: string): Set<string> {
    const db = new Database(dbPath, { readonly: true });
    try {
        return new Set(
            db
                .query<{ id: string }, []>('SELECT id FROM paths')
                .all()
                .map((row) => row.id),
        );
    } finally {
        db.close();
    }
}

function warningOf(manifest: BackupManifest, mountId: string, kind: string): string {
    return findOrFail(manifest.warnings ?? [], (warning) => warning.startsWith(`mount ${mountId}: ${kind}`));
}

describe('Backup of a home whose drives hold rows that do not reach the root', () => {
    const LOCAL_MOUNT_ID = 'backup-orphans-local';
    let user: TestUser;
    let home: Home;
    // Per mount: the ids left without a way to the root, and the child whose thumbnail must stay out.
    const orphans = new Map<string, { ids: string[]; childId: string; keptId: string }>();

    // A folder deleted with its child left behind, an a↔b cycle with a file in it, and a folder holding a file named
    // like one at the root, deleted the same way.
    async function seed(mountId: string): Promise<void> {
        const mount = findOrFail(home.drive.getMounts(), (m) => m.id === mountId);
        const root = await rootOf(user, mountId);
        const folder = (parentId: string, folderName: string) =>
            drivePost(user.sessionToken, user.id, mountId, `folder/${parentId}`, { folderName });
        const kept = await upload(user, mountId, root.id, 'kept.png', TEST_PNG_BYTES);
        await upload(user, mountId, root.id, 'same.txt', 'root bytes');
        const lost = await folder(root.id, 'Lost');
        const child = await upload(user, mountId, lost.id, 'lost-child.png', TEST_PNG_BYTES);
        for (const id of [kept.id, child.id]) {
            await saveThumbnail(mount.thumbsDir, id, Buffer.from(TEST_PNG_BYTES), 'image/png', 'x.png');
        }
        const loopA = await folder(root.id, 'Loop A');
        const loopB = await folder(root.id, 'Loop B');
        const looped = await upload(user, mountId, loopA.id, 'looped.txt', 'looped bytes');
        const shadow = await folder(root.id, 'Shadow');
        const shadowed = await upload(user, mountId, shadow.id, 'same.txt', 'orphan bytes');
        writeWithoutForeignKeys(home.homeDir, mountId, [
            ['DELETE FROM paths WHERE id IN (?, ?)', [lost.id, shadow.id]],
            ['UPDATE paths SET parentId = ? WHERE id = ?', [loopB.id, loopA.id]],
            ['UPDATE paths SET parentId = ? WHERE id = ?', [loopA.id, loopB.id]],
        ]);
        orphans.set(mountId, {
            ids: [child.id, loopA.id, loopB.id, looped.id, shadowed.id],
            childId: child.id,
            keptId: kept.id,
        });
    }

    beforeAll(async () => {
        await getTestContext();
        let mountId: string;
        ({ user, home, mountId } = await newUser('orphans'));
        const settings = await home.settings.set({
            mounts: { [LOCAL_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'By name' } },
        });
        await home.drive.addMount(createMountConfig(LOCAL_MOUNT_ID, settings.mounts![LOCAL_MOUNT_ID]));
        // The suite's default mount is local-key; the second one stores files by name.
        expect(findOrFail(home.drive.getMounts(), (m) => m.id === mountId).config.storageType).toBe('local-key');
        await seed(mountId);
        await seed(LOCAL_MOUNT_ID);
    });

    for (const level of ['full', 'light'] as const) {
        test(`a ${level} archive leaves them out, names them and verifies, and the live table keeps them`, async () => {
            const { manifest, folder } = await snapshotInto(home, level);
            expect((await verifyFolder(folder)).failures).toEqual([]);
            for (const [mountId, { ids }] of orphans) {
                const warning = warningOf(manifest, mountId, ORPHAN_WARNING);
                for (const name of ['lost-child.png', 'Loop A', 'Loop B', 'looped.txt', 'same.txt']) {
                    expect(warning).toContain(name);
                }
                const archived = rowIds(join(folder, 'home', PATHS.DRIVE.ROOT, mountId, PATHS.DRIVE.METADATA_DB));
                const live = rowIds(metadataPath(home.homeDir, mountId));
                for (const id of ids) {
                    expect(archived.has(id)).toBe(false);
                    expect(live.has(id)).toBe(true);
                }
            }
        });
    }

    test('a full archive holds no thumbnail of them, and the bytes of a root file named like one stay its own', async () => {
        const { manifest, folder } = await snapshotInto(home, 'full');
        const paths = new Set(manifest.entries.map((entry) => entry.path));
        for (const [mountId, { childId, keptId }] of orphans) {
            const mountDir = `home/${PATHS.DRIVE.ROOT}/${mountId}`;
            expect(paths.has(`${mountDir}/${PATHS.DRIVE.THUMBS_DIR}/${keptId}.webp`)).toBe(true);
            expect(paths.has(`${mountDir}/${PATHS.DRIVE.THUMBS_DIR}/${childId}.webp`)).toBe(false);
            const data = `${mountDir}/${PATHS.DRIVE.DATA_DIR}`;
            expect(readFileSync(join(folder, data, 'same.txt'), 'utf8')).toBe('root bytes');
            expect([...paths].filter((path) => path.startsWith(`${data}/`)).sort()).toEqual(
                [`${data}/kept.png`, `${data}/same.txt`].sort(),
            );
        }
    });

    test('a drive whose root row is gone fails the home', async () => {
        const { home: rootless, mountId } = await newUser('rootless');
        writeWithoutForeignKeys(rootless.homeDir, mountId, [['DELETE FROM paths WHERE parentId IS NULL', []]]);
        for (const level of ['full', 'light'] as const) {
            await expect(snapshotInto(rootless, level)).rejects.toThrow(`mount ${mountId}: the table has no root row`);
        }
    });
});

describe('Backup of a home whose drive lost files', () => {
    let user: TestUser;
    let home: Home;
    let mountId: string;
    let mount: Mount;
    // The rows whose objects are gone, by the archive path the warning names them by.
    const lost = new Map<string, string>();

    async function dropObject(id: string): Promise<void> {
        expect((await mount.getPath(id))?.size).toBeGreaterThan(0);
        await mount.storage.delete(await mount.getStorageKey(id));
    }

    beforeAll(async () => {
        await getTestContext();
        ({ user, home, mountId, mount } = await newUser('lost'));
        const root = await rootOf(user, mountId);
        const doc = (fileName: string) =>
            drivePost(user.sessionToken, user.id, mountId, `folder/${root.id}/create/doc`, { fileName });
        await upload(user, mountId, root.id, 'kept.png', TEST_PNG_BYTES);
        const plain = await upload(user, mountId, root.id, 'lost.png', TEST_PNG_BYTES);

        const container = await doc('Lost Doc');
        const versioned = await doc('Versioned Doc');
        const saved = await authedRequest(
            user.sessionToken,
            `/drive/${user.id}/${mountId}/file/${versioned.id}/versions/save`,
            { method: 'POST' },
        );
        expect(saved.status).toBe(200);
        const versions = (await mount.getChildByName(versioned.id, 'versions'))!;
        const [snapshot] = await mount.db.select().from(paths).where(eq(paths.parentId, versions.id)).all();

        // Closed first: with a live handle the copy comes from VACUUM INTO and never reaches storage. The close's
        // final sync kicks a content reindex, which would open data.db again.
        const dataDb = (await mount.getChildByName(container.id, 'data.db'))!;
        const kick = spyOn(mount.reindexQueue!, 'kick').mockImplementation(() => {});
        try {
            await mount.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
            for (const id of [plain.id, dataDb.id, snapshot.id]) await dropObject(id);
        } finally {
            kick.mockRestore();
        }
        lost.set('lost.png', plain.id);
        lost.set('Lost Doc.eigendoc/data.db', dataDb.id);
        lost.set(`Versioned Doc.eigendoc/versions/${snapshot.name}`, snapshot.id);
    });

    test('the archive keeps their rows without bytes, names them and verifies', async () => {
        const { manifest, folder } = await snapshotInto(home);
        expect((await verifyFolder(folder)).failures).toEqual([]);
        const warning = warningOf(manifest, mountId, LOST_WARNING);
        const data = `home/${PATHS.DRIVE.ROOT}/${mountId}/${PATHS.DRIVE.DATA_DIR}`;
        const entries = new Set(manifest.entries.map((entry) => entry.path));
        expect(entries.has(`${data}/kept.png`)).toBe(true);
        const archived = rowIds(join(folder, 'home', PATHS.DRIVE.ROOT, mountId, PATHS.DRIVE.METADATA_DB));
        for (const [relPath, id] of lost) {
            expect(warning).toContain(relPath);
            expect(entries.has(`${data}/${relPath}`)).toBe(false);
            expect(archived.has(id)).toBe(true);
        }
    });

    test('the admin pane lists the warnings, and the archive restores a home whose rows have no object', async () => {
        const job = await waitForJob(
            startBackupJob('backup', user.id, undefined, (started, onProgress) =>
                runHomeBackup(user.id, started, onProgress),
            ).id,
        );
        expect(job.error).toBeUndefined();
        const artifact = findOrFail(await listArtifacts(user.id), (listed) => listed.name === job.artifact);
        expect(artifact.verify.status).toBe('verified');
        expect(artifact.manifest?.warnings?.[0]).toStartWith(`mount ${mountId}: ${LOST_WARNING}`);

        await restoreHome(job.artifact!, user.id, `restore-lost-${Date.now()}`);
        const restored = findOrFail((await getHome(user.id)).drive.getMounts(), (m) => m.id === mountId);
        for (const id of lost.values()) {
            expect(await restored.getPath(id)).not.toBeNull();
            expect(await restored.readKey(await restored.getStorageKey(id))).toBeNull();
        }
    });
});

describe('Backup of a drive that holds no object at all', () => {
    test('a drive whose every object is gone fails the home as unreachable', async () => {
        const { user, home, mountId, mount } = await newUser('all-lost');
        const root = await rootOf(user, mountId);
        for (const name of ['a.png', 'b.png']) {
            const file = await upload(user, mountId, root.id, name, TEST_PNG_BYTES);
            await mount.storage.delete(await mount.getStorageKey(file.id));
        }
        await expect(snapshotInto(home)).rejects.toThrow(`mount ${mountId}: storage unreachable`);
    });

    // An unreadable folder answers every exists() with false, as a missing one does.
    test.skipIf(process.getuid?.() === 0)('a drive whose data folder cannot be read fails the home', async () => {
        const { user, home, mountId } = await newUser('unreadable');
        const root = await rootOf(user, mountId);
        for (const name of ['a.png', 'b.png']) await upload(user, mountId, root.id, name, TEST_PNG_BYTES);
        const dataDir = join(home.homeDir, PATHS.DRIVE.ROOT, mountId, PATHS.DRIVE.DATA_DIR);
        expect(existsSync(dataDir)).toBe(true);
        chmodSync(dataDir, 0);
        try {
            await expect(snapshotInto(home)).rejects.toThrow(`mount ${mountId}: storage unreachable`);
        } finally {
            chmodSync(dataDir, 0o755);
        }
    });
});
