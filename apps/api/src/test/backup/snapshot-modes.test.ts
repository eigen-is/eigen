import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupLevel, BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { parseBackupManifest } from '@workspace/lib/validation';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { HOME_DATABASE_PATHS } from '../../lib/backup/archive-layout';
import * as captureModule from '../../lib/backup/capture';
import { buildHomeFolderName } from '../../lib/backup/paths';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { verifyFolder } from '../../lib/backup/verify';
import type { DatabaseConfig } from '../../lib/core';
import type { Home } from '../../lib/home';
import { evictHome, getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import * as mountHelpers from '../../lib/mount/helpers';
import type { Mount } from '../../lib/mount/mount';
import { saveThumbnail } from '../../lib/shared/thumbnails';
import {
    createHomeFaultMount,
    type FaultStorage,
    provisionDoc,
    registerFaultMount,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    createTestUser,
    drivePost,
    driveUpload,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
    type TestUser,
} from '../setup';

// The two capture modes a whole-server archive adds to snapshotHome, and the manifest fields that
// say a member is not a complete home: Light keeps every database and no file bodies or mail, Full
// keeps an s3 mount's metadata.db and staged uploads and leaves its objects to the bucket.

const S3_MOUNT_ID = 'modes-s3';
// A flat-key mount on local disk: remote in its key shape, local in where its bytes live.
const LOCAL_KEY_MOUNT_ID = 'modes-local-key';
const MAILDIR = 'home/eigen.mail/Maildir';

const docSchema = { items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }) };
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'backup-modes-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

let user: TestUser;
let home: Home;
let defaultMountId: string;
let s3Mount: Mount;
let s3Fault: FaultStorage;
let backingRoot: string;
let pendingObjectKey: string;

async function snapshot(level?: BackupLevel): Promise<{ manifest: BackupManifest; folder: string }> {
    const target = mkdtempSync(join(TEST_DATA_DIR, `backup-modes-${level ?? 'default'}-`));
    const manifest = await snapshotHome(home, target, { level });
    return { manifest, folder: join(target, buildHomeFolderName(home.user.id)) };
}

function entryPaths(manifest: BackupManifest): string[] {
    return manifest.entries.map((entry) => entry.path);
}

function mountEntries(manifest: BackupManifest, mountId: string): string[] {
    return entryPaths(manifest).filter((p) => p.startsWith(`home/mounts/${mountId}/`));
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

function pendingStagingName(metadataPath: string, storageKey: string): string | null {
    const db = new Database(metadataPath, { readonly: true });
    try {
        return (
            db
                .query<{ stagingPath: string }, [string]>(
                    'SELECT stagingPath FROM pending_uploads WHERE storageKey = ?',
                )
                .get(storageKey)?.stagingPath ?? null
        );
    } finally {
        db.close();
    }
}

// A Full snapshot during which `gone` is deleted just before its copy starts: the capture goes on
// and the archive holds no entry and no file for it.
async function snapshotWhileVanishing(
    gone: string,
    archived: string,
): Promise<{ manifest: BackupManifest; folder: string }> {
    const capture = captureModule.captureFile;
    const spy = spyOn(captureModule, 'captureFile').mockImplementation(async (source, destPath, relPath) => {
        if (relPath === archived) rmSync(gone);
        return capture(source, destPath, relPath);
    });
    try {
        const snapshotted = await snapshot('full');
        expect(spy.mock.calls.some(([, , relPath]) => relPath === archived)).toBe(true);
        expect(entryPaths(snapshotted.manifest)).not.toContain(archived);
        expect(existsSync(join(snapshotted.folder, archived))).toBe(false);
        return snapshotted;
    } finally {
        spy.mockRestore();
        rmSync(gone, { force: true });
    }
}

beforeAll(async () => {
    const ctx = await getTestContext();
    user = await createTestUser('backup-modes@test.eigen.is', 'testpassword123', 'Backup Modes');
    home = await getHome(user.id);

    const mounts = await assertJson<{ id: string }[]>(
        await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
    );
    defaultMountId = mounts[0].id;
    const root = await assertJson<DrivePath>(
        await authedRequest(user.sessionToken, `/drive/${user.id}/${defaultMountId}/root`),
    );
    // A file with a thumbnail and a container: file bodies and container databases of a local mount.
    const kept = await driveUpload<DrivePath>(
        user.sessionToken,
        user.id,
        defaultMountId,
        root.id,
        new File([TEST_PNG_BYTES], 'kept.png', { type: 'image/png' }),
    );
    const keptMount = home.drive.getMounts().find((mount) => mount.id === defaultMountId);
    await saveThumbnail(keptMount!.thumbsDir, kept.id, Buffer.from(TEST_PNG_BYTES), 'image/png', 'kept.png');
    await drivePost(user.sessionToken, user.id, defaultMountId, `folder/${root.id}/create/doc`, {
        fileName: 'Modes Doc',
    });

    const eml = [`From: sender@external.com`, `To: ${user.email}`, 'Subject: Modes', '', 'body'].join('\r\n');
    const delivered = await ctx.app.handle(
        new Request(`http://localhost/mail/deliver/${user.email}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    expect(delivered.status).toBe(200);
    expect(existsSync(join(home.homeDir, 'eigen.mail', 'Maildir'))).toBe(true);

    const settings = await home.settings.set({
        mounts: { [LOCAL_KEY_MOUNT_ID]: { storageType: 'local-key', maxSizeMB: 100, enabled: true, name: 'Flat' } },
    });
    await home.drive.addMount(createMountConfig(LOCAL_KEY_MOUNT_ID, settings.mounts![LOCAL_KEY_MOUNT_ID]));
    const flatRoot = await assertJson<DrivePath>(
        await authedRequest(user.sessionToken, `/drive/${user.id}/${LOCAL_KEY_MOUNT_ID}/root`),
    );
    await driveUpload<DrivePath>(
        user.sessionToken,
        user.id,
        LOCAL_KEY_MOUNT_ID,
        flatRoot.id,
        new File([TEST_PNG_BYTES], 'flat.png', { type: 'image/png' }),
    );

    // The s3 mount: one object the bucket holds, one upload still waiting in staging/.
    backingRoot = mkdtempSync(join(TEST_DATA_DIR, 'backup-modes-backing-'));
    ({ mount: s3Mount, fault: s3Fault } = createHomeFaultMount(home, S3_MOUNT_ID, backingRoot));
    await s3Mount.init();
    registerFaultMount(home.drive, s3Mount);
    const s3Root = (await s3Mount.getRootFolder())!.id;
    await s3Mount.createFile(s3Root, 'stored.png', 'image/png', TEST_PNG_BYTES.byteLength, TEST_PNG_BYTES);
    const storedBytes = new TextEncoder().encode('in the bucket');
    const pending = await s3Mount.createFile(s3Root, 'pending.txt', 'text/plain', storedBytes.byteLength, storedBytes);
    await s3Mount.drainPendingUploads({ flushNow: true });
    pendingObjectKey = await s3Mount.getStorageKey(pending);
    // What an outage leaves: newer bytes in staging/ with a pending row, their PUT parked.
    s3Fault.parkWrites = true;
    const queue = s3Mount.uploadQueue!;
    const stagingPath = queue.newStagingPath();
    await Bun.write(stagingPath, 'not in the bucket yet');
    queue.enqueueStaged(pendingObjectKey, stagingPath, false);
    await s3Fault.waitForParked((write) => write.key === pendingObjectKey);
}, 30_000);

afterAll(async () => {
    s3Fault.parkWrites = false;
    await s3Fault.landAllRemaining();
    unregisterFaultMount(home.drive, S3_MOUNT_ID);
    await s3Mount.closeAllDatabases();
    rmSync(backingRoot, { recursive: true, force: true });
});

describe('Backup capture modes', () => {
    test('a Light snapshot holds every database and no file bodies or mail, and says so', async () => {
        const { manifest, folder } = await snapshot('light');
        expect(manifest.level).toBe('light');

        const paths = entryPaths(manifest);
        const homeDatabases = [...HOME_DATABASE_PATHS].filter((rel) => existsSync(join(home.homeDir, rel)));
        const mountDatabases = [defaultMountId, LOCAL_KEY_MOUNT_ID, S3_MOUNT_ID].map(
            (id) => `mounts/${id}/metadata.db`,
        );
        for (const rel of [...homeDatabases, ...mountDatabases]) expect(paths).toContain(`home/${rel}`);
        expect(manifest.counts.databases).toBe(homeDatabases.length + mountDatabases.length);

        // A mount contributes its metadata.db and nothing else: no data/, thumbs/ or staging/.
        expect(paths.filter((p) => /^home\/mounts\/[^/]+\/(?!metadata\.db$)/.test(p))).toEqual([]);
        expect(paths.filter((p) => p.startsWith(`${MAILDIR}/`))).toEqual([]);
        expect(existsSync(join(folder, MAILDIR))).toBe(false);
        expect(paths).toContain('auth.json');

        for (const summary of manifest.mounts) {
            expect(summary).toMatchObject({ contents: 'metadata', files: 0, bytes: 0 });
        }
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('a Full snapshot keeps an s3 mount to its metadata.db and staged uploads, and says so', async () => {
        const { manifest, folder } = await snapshot('full');
        expect(manifest.level).toBe('full');

        const s3Entries = mountEntries(manifest, S3_MOUNT_ID);
        expect(s3Entries).toContain(`home/mounts/${S3_MOUNT_ID}/metadata.db`);
        expect(s3Entries.filter((p) => p.includes('/data/'))).toEqual([]);
        const staged = s3Entries.filter((p) => p.startsWith(`home/mounts/${S3_MOUNT_ID}/staging/`));
        expect(staged.length).toBeGreaterThan(0);
        // The waiting upload is in the archive under the name its pending row gives it.
        const stagingName = pendingStagingName(
            join(folder, `home/mounts/${S3_MOUNT_ID}/metadata.db`),
            pendingObjectKey,
        );
        expect(staged).toContain(`home/mounts/${S3_MOUNT_ID}/staging/${stagingName}`);
        expect(await Bun.file(join(folder, `home/mounts/${S3_MOUNT_ID}/staging/${stagingName}`)).text()).toBe(
            'not in the bucket yet',
        );

        const s3Summary = manifest.mounts.find((summary) => summary.id === S3_MOUNT_ID);
        expect(s3Summary?.contents).toBe('metadata');
        expect(s3Summary?.files).toBe(staged.length);

        // A mount on local disk is complete at every level above Light, whatever shape its keys have.
        for (const [mountId, name] of [
            [defaultMountId, 'kept.png'],
            [LOCAL_KEY_MOUNT_ID, 'flat.png'],
        ]) {
            const localSummary = manifest.mounts.find((summary) => summary.id === mountId);
            expect(localSummary && 'contents' in localSummary).toBe(false);
            expect(mountEntries(manifest, mountId)).toContain(`home/mounts/${mountId}/data/${name}`);
        }
        expect(existsSync(join(folder, MAILDIR))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    // A staged copy goes when its PUT acks or a newer copy supersedes it (UploadQueue.enqueueStaged),
    // and neither may fail the capture it happened during.
    test('a staged upload gone between the listing and its copy is left out, not a failure', async () => {
        const gone = join(s3Mount.stagingDir, 'superseded.tmp');
        await Bun.write(gone, 'superseded by a newer copy');
        const { manifest, folder } = await snapshotWhileVanishing(
            gone,
            `home/mounts/${S3_MOUNT_ID}/staging/superseded.tmp`,
        );
        // The upload that is still waiting is copied all the same.
        expect(mountEntries(manifest, S3_MOUNT_ID).some((p) => p.includes('/staging/'))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    // A mail client's first look moves a message from new/ to cur/, so one can go mid-capture.
    test('a Maildir message moved between the listing and its copy is left out, not a failure', async () => {
        const gone = join(home.homeDir, 'eigen.mail/Maildir/new/1-vanishing.eigen');
        await Bun.write(gone, 'Subject: Moved\r\n\r\nbody');
        const { manifest, folder } = await snapshotWhileVanishing(gone, `${MAILDIR}/new/1-vanishing.eigen`);
        expect(entryPaths(manifest).some((p) => p.startsWith(`${MAILDIR}/`))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    // Deleting a file for good deletes its thumbnail (Mount.deletePath), so one can go mid-capture.
    test('a thumbnail deleted between the listing and its copy is left out, not a failure', async () => {
        const root = await assertJson<DrivePath>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/${defaultMountId}/root`),
        );
        const note = await driveUpload<DrivePath>(
            user.sessionToken,
            user.id,
            defaultMountId,
            root.id,
            new File(['a note'], 'vanishing.txt', { type: 'text/plain' }),
        );
        const mount = home.drive.getMounts().find((candidate) => candidate.id === defaultMountId)!;
        const gone = join(mount.thumbsDir, `${note.id}.webp`);
        await Bun.write(gone, TEST_PNG_BYTES);
        const { manifest, folder } = await snapshotWhileVanishing(
            gone,
            `home/mounts/${defaultMountId}/thumbs/${note.id}.webp`,
        );
        expect(mountEntries(manifest, defaultMountId).some((p) => p.includes('/thumbs/'))).toBe(true);
        expect((await verifyFolder(folder)).status).toBe('verified');
    });

    test('an edit made a second before a Full snapshot is in its staged uploads', async () => {
        const { containerId, dataDbId } = await provisionDoc(s3Mount);
        const managed = await s3Mount.createDatabase(docConfig, dataDbId);
        try {
            // Never flushed: only the open handle holds it until the capture flushes.
            managed.db.insert(docSchema.items).values({ id: 1, data: 'a second ago' }).run();
            const storageKey = await s3Mount.getStorageKey(dataDbId);

            const { folder } = await snapshot('full');
            const stagingName = pendingStagingName(join(folder, `home/mounts/${S3_MOUNT_ID}/metadata.db`), storageKey);
            expect(stagingName).not.toBeNull();
            expect(readMarkers(join(folder, `home/mounts/${S3_MOUNT_ID}/staging/${stagingName}`))).toEqual([
                'a second ago',
            ]);
        } finally {
            await s3Mount.deletePath(containerId);
        }
    });

    test('the default snapshot is complete: every s3 object, no staging/, level full-s3', async () => {
        const { manifest, folder } = await snapshot();
        expect(manifest.level).toBe('full-s3');
        for (const summary of manifest.mounts) expect('contents' in summary).toBe(false);

        const s3Entries = mountEntries(manifest, S3_MOUNT_ID);
        expect(s3Entries).toContain(`home/mounts/${S3_MOUNT_ID}/data/stored.png`);
        expect(s3Entries).toContain(`home/mounts/${S3_MOUNT_ID}/data/pending.txt`);
        expect(s3Entries.filter((p) => p.includes('/staging/'))).toEqual([]);
        expect(existsSync(join(folder, MAILDIR))).toBe(true);
    });

    test('a manifest naming a level or contents this build does not know is not a manifest', async () => {
        const { manifest } = await snapshot('full');
        expect(parseBackupManifest(JSON.stringify(manifest))).not.toBeNull();
        expect(parseBackupManifest(JSON.stringify({ ...manifest, level: 'partial' }))).toBeNull();
        const mounts = manifest.mounts.map((summary) => ({ ...summary, contents: 'thumbs' }));
        expect(parseBackupManifest(JSON.stringify({ ...manifest, mounts }))).toBeNull();
    });
});

describe('Backup capture modes of a disabled mount', () => {
    const DISABLED_MOUNT_ID = 'modes-disabled';

    // Light reads no storage, so a disabled mount's storage being out of reach is no reason to drop
    // it: it keeps its metadata.db as every other mount does at Light.
    test('a Light snapshot keeps the metadata.db of a disabled mount whose storage cannot be built', async () => {
        await getTestContext();
        const owner = await createTestUser('backup-modes-disabled@test.eigen.is', 'testpassword123', 'Modes Off');
        const ownerHome = await getHome(owner.id);
        const on = await ownerHome.settings.set({
            mounts: {
                [DISABLED_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Switched Off' },
            },
        });
        await ownerHome.drive.addMount(createMountConfig(DISABLED_MOUNT_ID, on.mounts![DISABLED_MOUNT_ID]));
        const off = await ownerHome.settings.set({
            mounts: { [DISABLED_MOUNT_ID]: { ...on.mounts![DISABLED_MOUNT_ID], enabled: false } },
        });
        await ownerHome.drive.updateMount(createMountConfig(DISABLED_MOUNT_ID, off.mounts![DISABLED_MOUNT_ID]), false);

        const spy = spyOn(mountHelpers, 'createMountStorage').mockImplementation(() => {
            throw new Error('storage unreachable');
        });
        let manifest: BackupManifest;
        try {
            manifest = await snapshotHome(ownerHome, mkdtempSync(join(TEST_DATA_DIR, 'backup-modes-disabled-')), {
                level: 'light',
            });
        } finally {
            spy.mockRestore();
        }

        const summary = manifest.mounts.find((mount) => mount.id === DISABLED_MOUNT_ID);
        expect(summary).toEqual({
            id: DISABLED_MOUNT_ID,
            storageType: 'local',
            files: 0,
            bytes: 0,
            contents: 'metadata',
        });
        expect(entryPaths(manifest)).toContain(`home/mounts/${DISABLED_MOUNT_ID}/metadata.db`);
    });
});

describe('Backup of an enabled mount the drive could not open', () => {
    // The drive leaves out a mount whose init throws, and a capture that skipped it too would hold a home without
    // that mount's files, verify and pass: a restore would bring it back empty.
    test('fails the capture, naming the mount', async () => {
        await getTestContext();
        const owner = await createTestUser('backup-modes-broken@test.eigen.is', 'testpassword123', 'Modes Broken');
        const ownerHome = await getHome(owner.id);
        await ownerHome.settings.set({
            mounts: { broken: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Broken' } },
        });
        mkdirSync(join(ownerHome.homeDir, 'mounts/broken'), { recursive: true });
        writeFileSync(join(ownerHome.homeDir, 'mounts/broken/metadata.db'), 'not a database');
        await evictHome(owner.id);
        const reopened = await getHome(owner.id);
        expect(reopened.drive.getMounts().map((mount) => mount.id)).not.toContain('broken');

        for (const level of ['light', 'full'] as const) {
            const target = mkdtempSync(join(TEST_DATA_DIR, 'backup-modes-broken-'));
            await expect(snapshotHome(reopened, target, { level })).rejects.toThrow('broken');
        }
    });
});
