import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_HOME_REPLACED_CLOSE } from '@workspace/lib/constants/collab';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { apikey as apikeyScheme, user as userScheme } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import * as pathsModule from '../../lib/backup/paths';
import {
    ARCHIVE_AVATAR_DIR,
    buildArtifactName,
    buildHomeFolderName,
    FAILED_RESTORE_SUFFIX,
    getBackupsDir,
    PRE_RESTORE_SUFFIX,
} from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getAvatarsDir } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import { paths } from '../../lib/mount/schema';
import { getEigenDb } from '../../lib/share/db';
import { shareRegistry } from '../../lib/share/schema';
import { saveThumbnail } from '../../lib/shared/thumbnails';
import { createHomeFaultMount, registerFaultMount, unregisterFaultMount } from '../fault-storage-helpers';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    createTestUser,
    driveGetList,
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
    type TestUser,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const PASSWORD = 'testpassword123';
// A share to an address with no account is what writes a share_registry row (acl-propagation.ts).
const SHARE_TARGET = 'restore-outsider@external.test';
// Every home's drive root holds this folder from the start; it rides along in every listing below.
const CHATS_FOLDER = 'chats';
// A second mount on the path-based backend: its archive tree IS its storage layout, and its empty
// folders exist only in the paths table. The harness's default mount is local-key (setup uses
// 'local-id'), so both key shapes are restored here.
const LOCAL_MOUNT_ID = 'restore-local';

// One artifact of the home as it stands now, in the backups folder restoreHome reads from.
// `patch` doctors the unpacked folder before it is packed, which is how a restore is made to fail
// after the move-aside — the manifest itself is not hashed, so a doctored file only has to restate
// its own entry (restateEntry) to get past verify and be judged by the step under test.
async function backup(
    userId: string,
    at: Date,
    patch?: (manifest: BackupManifest, folder: string) => Promise<void> | void,
): Promise<string> {
    const home = await getHome(userId);
    const staging = mkdtempSync(join(TEST_DATA_DIR, 'restore-backup-'));
    const folder = join(staging, buildHomeFolderName(userId));
    const manifest = await snapshotHome(home, staging);
    if (patch) {
        await patch(manifest, folder);
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    const name = buildArtifactName(userId, at);
    await packFolder(folder, join(getBackupsDir(), name));
    rmSync(staging, { recursive: true, force: true });
    return name;
}

async function deliverMail(email: string, subject: string): Promise<void> {
    const eml = [`From: sender@external.com`, `To: ${email}`, `Subject: ${subject}`, '', 'body'].join('\r\n');
    const ctx = await getTestContext();
    const res = await ctx.app.handle(
        new Request(`http://localhost/mail/deliver/${email}`, {
            method: 'POST',
            headers: { 'Content-Type': 'message/rfc822' },
            body: new TextEncoder().encode(eml).buffer as ArrayBuffer,
        }),
    );
    expect(res.status).toBe(200);
}

function rootNames(token: string, ownerId: string, mountId: string, rootId: string): Promise<string[]> {
    return driveGetList(token, ownerId, mountId, `folder/${rootId}`).then((items) =>
        items.map((item) => item.name).sort(),
    );
}

// Re-state one manifest entry for the bytes now on disk, so a deliberate change is judged by the
// step under test instead of by verify's hashes.
async function restateEntry(manifest: BackupManifest, folder: string, relPath: string): Promise<void> {
    const entry = manifest.entries.find((e) => e.path === relPath);
    if (!entry) throw new Error(`${relPath} is not in the manifest`);
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(new Uint8Array(await Bun.file(join(folder, relPath)).arrayBuffer()));
    entry.bytes = Bun.file(join(folder, relPath)).size;
    entry.sha256 = hasher.digest('hex');
}

// Stamp an archived database with a schema version: higher than this build supports (a backup from a
// newer server) or lower than a restore can write (an archive from before a migration).
async function stampSchemaVersion(manifest: BackupManifest, folder: string, relPath: string, version: number) {
    const db = new Database(join(folder, relPath));
    try {
        db.run('UPDATE __schema_version SET version = ? WHERE id = 1', [version]);
    } finally {
        db.close();
    }
    await restateEntry(manifest, folder, relPath);
}

function safetyCopies(userId: string, suffix: string): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter((name) => name.startsWith(`${userId}${suffix}`));
}

// Where a flat-key mount stores one row's object: `paths.file` (Mount.getStorageKey).
function storageKeyIn(ownerId: string, mountId: string, pathId: string): string {
    const db = openMountMetadata(join(TEST_DATA_DIR, 'home', ownerId, 'mounts', mountId, 'metadata.db'));
    try {
        return db.query<{ file: string }, [string]>('SELECT file FROM paths WHERE id = ?').get(pathId)!.file;
    } finally {
        db.close();
    }
}

// Read-write on purpose: a closed WAL database has no -shm beside it, and a readonly open cannot
// create one (SQLITE_CANTOPEN) — which is exactly the shape of a home folder moved aside.
function mailSubjectsIn(homeFolder: string): string[] {
    const db = new Database(join(homeFolder, 'eigen.mail', 'mail.db'));
    try {
        return db
            .query<{ subject: string }, []>('SELECT subject FROM emails')
            .all()
            .map((row) => row.subject);
    } finally {
        db.close();
    }
}

describe('Backup restoreHome', () => {
    let ctx: TestCtx;
    let target: TestUser;
    let mountId: string;
    let rootId: string;
    let artifact: string;
    let docId: string;
    let keptFileId: string;
    let trashedFileId: string;
    let localRootId: string;
    let nestedFileId: string;
    let keptThumbPath: string;
    let port: number;

    beforeAll(async () => {
        ctx = await getTestContext();
        target = await createTestUser('restoreme@test.eigen.is', PASSWORD, 'Restore Me');

        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`),
        );
        mountId = mounts[0].id;
        rootId = (
            await assertJson<DrivePath>(await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/root`))
        ).id;

        const doc = await drivePost(target.sessionToken, target.id, mountId, `folder/${rootId}/create/doc`, {
            fileName: 'Kept Doc',
        });
        docId = doc.id;
        const kept = await driveUpload<DrivePath>(
            target.sessionToken,
            target.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'kept.png', { type: 'image/png' }),
        );
        const aclRes = await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/path/${kept.id}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: [{ id: SHARE_TARGET, read: true, write: false }] }),
        });
        expect(aclRes.status).toBe(200);
        keptFileId = kept.id;
        // A thumbnail is written once, at upload, and never regenerated — the drive route 404s for a
        // file whose thumbnail is gone — so a restore has to bring it back. Written here rather than
        // waited for, because the upload route generates it in the background.
        const keptMount = (await getHome(target.id)).drive.getMounts().find((m) => m.id === mountId);
        expect(keptMount).toBeTruthy();
        keptThumbPath = join(keptMount!.thumbsDir, `${kept.id}.webp`);
        expect(
            (await saveThumbnail(keptMount!.thumbsDir, kept.id, Buffer.from(TEST_PNG_BYTES), 'image/png', 'kept.png'))
                ?.fileName,
        ).toBe(`${kept.id}.webp`);
        // A trashed file and two version snapshots: both live in the paths table under their own key
        // shapes (`.trash/{id}.{ext}`, `{container}/versions/*.db`), so both have to come back.
        const trashed = await driveUpload<DrivePath>(
            target.sessionToken,
            target.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'trashed.png', { type: 'image/png' }),
        );
        trashedFileId = trashed.id;
        expect(
            (
                await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/path/${trashed.id}`, {
                    method: 'DELETE',
                })
            ).status,
        ).toBe(200);
        for (const _ of [0, 1]) {
            const saved = await authedRequest(
                target.sessionToken,
                `/drive/${target.id}/${mountId}/file/${doc.id}/versions/save`,
                { method: 'POST' },
            );
            expect(saved.status).toBe(200);
        }

        await deliverMail(target.email, 'Before the backup');
        await authedRequest(target.sessionToken, `/mail/${target.id}/mailbox/`);

        const home = await getHome(target.id);
        const settings = await home.settings.set({
            mounts: {
                [LOCAL_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Restore Local' },
            },
        });
        await home.drive.addMount(createMountConfig(LOCAL_MOUNT_ID, settings.mounts![LOCAL_MOUNT_ID]));
        localRootId = (
            await assertJson<DrivePath>(
                await authedRequest(target.sessionToken, `/drive/${target.id}/${LOCAL_MOUNT_ID}/root`),
            )
        ).id;
        const nested = await drivePost(target.sessionToken, target.id, LOCAL_MOUNT_ID, `folder/${localRootId}`, {
            folderName: 'Nested',
        });
        await drivePost(target.sessionToken, target.id, LOCAL_MOUNT_ID, `folder/${localRootId}`, {
            folderName: 'Empty Folder',
        });
        nestedFileId = (
            await driveUpload<DrivePath>(
                target.sessionToken,
                target.id,
                LOCAL_MOUNT_ID,
                nested.id,
                new File([TEST_PNG_BYTES], 'nested.png', { type: 'image/png' }),
            )
        ).id;

        artifact = await backup(target.id, new Date());

        const listenPort = ctx.app.listen(0).server?.port;
        expect(listenPort).toBeDefined();
        port = listenPort!;
    });

    afterAll(() => {
        ctx.app.stop();
    });

    test('puts the home back and keeps the changed state in .pre-restore', async () => {
        // Change the home after the backup: trash the document, add a file, take delivery of a mail.
        expect(
            (
                await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/path/${docId}`, {
                    method: 'DELETE',
                })
            ).status,
        ).toBe(200);
        await driveUpload(
            target.sessionToken,
            target.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'after-backup.png', { type: 'image/png' }),
        );
        await deliverMail(target.email, 'After the backup');
        await authedRequest(target.sessionToken, `/mail/${target.id}/mailbox/`);
        // ...and lose the thumbnail nothing would ever generate again.
        rmSync(keptThumbPath, { force: true });
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual([
            'after-backup.png',
            CHATS_FOLDER,
            'kept.png',
        ]);

        await restoreHome(artifact, target.id, `restore-roundtrip-${Date.now()}`);

        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual([
            'Kept Doc.eigendoc',
            CHATS_FOLDER,
            'kept.png',
        ]);
        // The flat-key mount: the archive holds its files by path, so every one of them had to be
        // moved back onto its storage key for a read to find the bytes.
        const keptDownload = await authedRequest(
            target.sessionToken,
            `/drive/${target.id}/${mountId}/file/${keptFileId}/download`,
        );
        expect(keptDownload.status).toBe(200);
        expect(new Uint8Array(await keptDownload.arrayBuffer())).toEqual(TEST_PNG_BYTES);

        // The trash and the version history are the file states nothing else keeps a copy of.
        const trash = await driveGetList(target.sessionToken, target.id, mountId, 'trash');
        expect(trash.map((item) => item.name)).toEqual(['trashed.png']);
        // The archive holds a trashed file under `.trash/{id}.{ext}`; this mount stores it under its
        // flat key like any other file, so the bytes are checked where the mount will look for them
        // (the download route refuses a trashed path, restore or no restore). The key is the one it
        // always had: only a remote mount's rows are rekeyed, because only its objects live outside
        // the folder that moved aside.
        const trashedKey = storageKeyIn(target.id, mountId, trashedFileId);
        expect(trashedKey).toBe(`${trashedFileId}.png`);
        const trashedBytes = await Bun.file(
            join(TEST_DATA_DIR, 'home', target.id, 'mounts', mountId, 'data', trashedKey),
        ).arrayBuffer();
        expect(new Uint8Array(trashedBytes)).toEqual(TEST_PNG_BYTES);
        const versions = await assertJson<{ name: string }[]>(
            await authedRequest(target.sessionToken, `/drive/${target.id}/${mountId}/file/${docId}/versions`),
        );
        expect(versions.length).toBe(2);

        const home = await getHome(target.id);
        const restoredMail = mailSubjectsIn(home.homeDir);
        expect(restoredMail).toContain('Before the backup');
        expect(restoredMail).not.toContain('After the backup');

        // The path-based mount: its tree is the storage layout, and an empty folder exists only in
        // the paths table — so the restore has to put it back on disk itself.
        expect(await rootNames(target.sessionToken, target.id, LOCAL_MOUNT_ID, localRootId)).toEqual([
            'Empty Folder',
            'Nested',
        ]);
        const download = await authedRequest(
            target.sessionToken,
            `/drive/${target.id}/${LOCAL_MOUNT_ID}/file/${nestedFileId}/download`,
        );
        expect(download.status).toBe(200);
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(TEST_PNG_BYTES);
        expect(
            existsSync(join(TEST_DATA_DIR, 'home', target.id, 'mounts', LOCAL_MOUNT_ID, 'data', 'Empty Folder')),
        ).toBe(true);

        // An empty Maildir folder: no file implies it, so only a directory entry in the tar carries
        // it — and MaildirStore.watch installs no fs.watch on a `new/` that is not there, which
        // stops mail syncing in silence. Nothing recreates it either: createStandardMailboxes only
        // runs when the whole Maildir is missing.
        expect(existsSync(join(TEST_DATA_DIR, 'home', target.id, 'eigen.mail', 'Maildir', '.Archive', 'new'))).toBe(
            true,
        );

        // The thumbnail is back where the mount looks for it, and the route serves it again.
        expect(existsSync(keptThumbPath)).toBe(true);
        const thumb = await authedRequest(
            target.sessionToken,
            `/drive/${target.id}/${mountId}/thumb/${keptFileId}.webp`,
        );
        expect(thumb.status).toBe(200);
        expect(thumb.headers.get('content-type')).toBe('image/webp');

        const [preRestore] = safetyCopies(target.id, PRE_RESTORE_SUFFIX);
        expect(preRestore).toBeTruthy();
        expect(mailSubjectsIn(join(TEST_DATA_DIR, 'home', preRestore))).toContain('After the backup');
    });

    test('an open collab socket is closed with 1012 home-replaced', async () => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${target.id}/${mountId}/${docId}`, {
            headers: { cookie: `better-auth.session_token=${target.sessionToken}` },
        } as unknown as string[]);
        const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
            ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
            ws.onerror = (event) => reject(event);
        });
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = (event) => reject(event);
        });

        await restoreHome(artifact, target.id, `restore-ws-${Date.now()}`);

        expect(await closed).toEqual({ code: COLLAB_HOME_REPLACED_CLOSE, reason: 'home-replaced' });
    });

    test('a socket that connects while the mark is set is closed 1012, never 1013', async () => {
        const { markHomeRestoring, clearHomeRestoring } = await import('../../lib/home/get-home');
        markHomeRestoring(target.id);
        try {
            const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${target.id}/${mountId}/${docId}`, {
                headers: { cookie: `better-auth.session_token=${target.sessionToken}` },
            } as unknown as string[]);
            const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
                ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
                ws.onerror = (event) => reject(event);
            });
            // 1013 would make this tab keep its document and retry — straight back over the restore.
            expect(closed).toEqual({ code: COLLAB_HOME_REPLACED_CLOSE, reason: 'home-replaced' });
        } finally {
            clearHomeRestoring(target.id);
        }
    });

    test('a second restore of one home is refused and touches nothing', async () => {
        const { markHomeRestoring, clearHomeRestoring } = await import('../../lib/home/get-home');
        const before = safetyCopies(target.id, PRE_RESTORE_SUFFIX).length;
        markHomeRestoring(target.id);
        try {
            await expect(restoreHome(artifact, target.id, `restore-second-${Date.now()}`)).rejects.toThrow(
                'Restore already in progress',
            );
        } finally {
            clearHomeRestoring(target.id);
        }
        expect(safetyCopies(target.id, PRE_RESTORE_SUFFIX).length).toBe(before);
        // The mark the first restore holds is still its own: this one did not clear it on its way out.
        expect((await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`)).status).toBe(200);
    });

    test('a path-based row whose name and file differ comes back readable', async () => {
        // What mount migration v7 leaves behind: it renamed the NAME of a deduplicated row and left
        // its `file` alone, so the archive's by-name tree and the mount's storage key disagree.
        const home = await getHome(target.id);
        const localMount = home.drive.getMounts().find((m) => m.id === LOCAL_MOUNT_ID);
        expect(localMount).toBeTruthy();
        await localMount!.db.update(paths).set({ name: 'renamed.png' }).where(eq(paths.id, nestedFileId));

        const artifactV7 = await backup(target.id, new Date(Date.now() + 120_000));
        await restoreHome(artifactV7, target.id, `restore-renamed-${Date.now()}`);

        const download = await authedRequest(
            target.sessionToken,
            `/drive/${target.id}/${LOCAL_MOUNT_ID}/file/${nestedFileId}/download`,
        );
        expect(download.status).toBe(200);
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(TEST_PNG_BYTES);
        rmSync(join(getBackupsDir(), artifactV7), { force: true });
    });

    test('the home is refused while the mark is set and served again once it clears', async () => {
        const { markHomeRestoring, clearHomeRestoring } = await import('../../lib/home/get-home');
        markHomeRestoring(target.id);
        try {
            await expect(getHome(target.id)).rejects.toThrow('Restore in progress');
            expect((await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`)).status).toBe(503);
        } finally {
            clearHomeRestoring(target.id);
        }
        expect((await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`)).status).toBe(200);
    });

    test('an artifact for another owner is refused before anything is touched', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        await expect(restoreHome(artifact, ctx.bob.user.id, `restore-mismatch-${Date.now()}`)).rejects.toThrow(
            /another home|not for/i,
        );
        expect(safetyCopies(ctx.bob.user.id, PRE_RESTORE_SUFFIX)).toEqual([]);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // The note the next boot reads to tell a restore that finished from one that died halfway. It
    // lives in the job's staging folder, which every restore wipes on its way out, so the wipe is
    // held off here to look at what was written.
    test('a finished restore leaves its completion note beside the marker', async () => {
        const jobId = `restore-sentinel-${Date.now()}`;
        const spy = spyOn(pathsModule, 'wipeBackupStagingDir').mockImplementation(() => {});
        try {
            await restoreHome(artifact, target.id, jobId);
        } finally {
            spy.mockRestore();
        }

        const staging = join(getBackupsDir(), '.staging', jobId);
        expect(existsSync(join(staging, 'restoring.json'))).toBe(true);
        expect(existsSync(join(staging, 'restore-complete.json'))).toBe(true);
        rmSync(staging, { recursive: true, force: true });
    });

    test('a failure after the move-aside leaves .failed-restore and puts the original back', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        // A mount the manifest promises but the archive has no metadata.db for: verify passes (it
        // reads entries, and the manifest itself is not hashed), materialization cannot.
        const doctored = await backup(target.id, new Date(Date.now() + 60_000), (manifest) => {
            manifest.mounts.push({ id: 'ghost-mount', storageType: 'local', files: 0, bytes: 0 });
        });

        await expect(restoreHome(doctored, target.id, `restore-ghost-${Date.now()}`)).rejects.toThrow(/ghost-mount/);

        expect(safetyCopies(target.id, FAILED_RESTORE_SUFFIX).length).toBe(1);
        expect(existsSync(join(TEST_DATA_DIR, 'home', target.id))).toBe(true);
        // The mark is cleared, so the home serves again — from the folder that was put back.
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });
});

describe('Backup restore refuses an archive this server cannot open', () => {
    // A remote mount, for the gate that only remote mounts meet. Its fake bucket sits outside the
    // home, the way createHomeFaultMount wants it.
    const S3_MOUNT_ID = 'restore-schema-s3';
    const S3_BACKING = join(TEST_DATA_DIR, 'restore-schema-backing');
    let user: TestUser;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('restore-schema@test.eigen.is', PASSWORD, 'Restore Schema');
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
        );
        mountId = mounts[0].id;
        rootId = (
            await assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`))
        ).id;
        await driveUpload(
            user.sessionToken,
            user.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'still-here.png', { type: 'image/png' }),
        );
    });

    test('a database from a newer server is refused and the home is put back', async () => {
        const before = await rootNames(user.sessionToken, user.id, mountId, rootId);
        const failedBefore = safetyCopies(user.id, FAILED_RESTORE_SUFFIX).length;
        // quick_check would pass this file; ManagedDatabase's forward-version guard would not, and it
        // fails the WHOLE home on the next load — long after the job said the restore was done.
        const artifact = await backup(user.id, new Date(), (manifest, folder) =>
            stampSchemaVersion(manifest, folder, 'home/eigen.mail/mail.db', 999),
        );

        await expect(restoreHome(artifact, user.id, `restore-newer-${Date.now()}`)).rejects.toThrow(
            /newer than this server/,
        );

        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX).length).toBe(failedBefore + 1);
        expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toEqual(before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    test('an s3 mount archived before pending_uploads carried its kind is refused', async () => {
        const before = await rootNames(user.sessionToken, user.id, mountId, rootId);
        const failedBefore = safetyCopies(user.id, FAILED_RESTORE_SUFFIX).length;
        // A restore writes the pending rows of a REMOTE mount itself, naming the isDatabase column;
        // on an older metadata.db that column does not exist, and taking its DEFAULT would let the
        // queue drop every restored plain file as corrupt. A local mount gets no such rows, so the
        // same archive is fine for it.
        const home = await getHome(user.id);
        const { mount } = createHomeFaultMount(home, S3_MOUNT_ID, S3_BACKING);
        await mount.init();
        registerFaultMount(home.drive, mount);
        try {
            const remoteRoot = await assertJson<DrivePath>(
                await authedRequest(user.sessionToken, `/drive/${user.id}/${S3_MOUNT_ID}/root`),
            );
            await driveUpload(
                user.sessionToken,
                user.id,
                S3_MOUNT_ID,
                remoteRoot.id,
                new File([TEST_PNG_BYTES], 'remote.png', { type: 'image/png' }),
            );
            await mount.drainPendingUploads({ flushNow: true });
            const artifact = await backup(user.id, new Date(Date.now() + 60_000), (manifest, folder) =>
                stampSchemaVersion(manifest, folder, `home/mounts/${S3_MOUNT_ID}/metadata.db`, 7),
            );

            await expect(restoreHome(artifact, user.id, `restore-older-${Date.now()}`)).rejects.toThrow(
                /too old to restore/,
            );

            expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX).length).toBe(failedBefore + 1);
            expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toEqual(before);
            rmSync(join(getBackupsDir(), artifact), { force: true });
        } finally {
            unregisterFaultMount(home.drive, S3_MOUNT_ID);
            await mount.closeAllDatabases().catch(() => {});
            rmSync(S3_BACKING, { recursive: true, force: true });
        }
    });

    test('a deleted user is not re-created by an archive that fails the check', async () => {
        const ctx = await getTestContext();
        const doomed = await createTestUser('restore-schema-deleted@test.eigen.is', PASSWORD, 'Restore Schema Deleted');
        expect((await authedRequest(doomed.sessionToken, `/drive/${doomed.id}/mounts`)).status).toBe(200);
        const artifact = await backup(doomed.id, new Date(), (manifest, folder) =>
            stampSchemaVersion(manifest, folder, 'home/eigen.mail/mail.db', 999),
        );
        expect(
            (await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${doomed.id}`, { method: 'DELETE' }))
                .status,
        ).toBe(200);

        await expect(restoreHome(artifact, doomed.id, `restore-deleted-newer-${Date.now()}`)).rejects.toThrow(
            /newer than this server/,
        );

        // The rollback moves folders; nothing takes a users3.db row back. So the check has to run
        // before the identity write, or this user could sign in with no home — and never be restored,
        // because the next attempt would find the user row and skip the insert.
        expect(getAuthDrizzleDb().select().from(userScheme).where(eq(userScheme.id, doomed.id)).all()).toEqual([]);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore after the user is deleted', () => {
    let ctx: TestCtx;
    let deleted: TestUser;
    let mountId: string;
    let rootId: string;
    let artifact: string;
    let avatarPath: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        deleted = await createTestUser('restore-deleted@test.eigen.is', PASSWORD, 'Restore Deleted');
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(deleted.sessionToken, `/drive/${deleted.id}/mounts`),
        );
        mountId = mounts[0].id;
        rootId = (
            await assertJson<DrivePath>(
                await authedRequest(deleted.sessionToken, `/drive/${deleted.id}/${mountId}/root`),
            )
        ).id;
        const file = await driveUpload(
            deleted.sessionToken,
            deleted.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'gone-with-me.png', { type: 'image/png' }),
        );
        expect(
            (
                await authedRequest(deleted.sessionToken, `/drive/${deleted.id}/${mountId}/path/${file.id}/acl`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: SHARE_TARGET, read: true, write: false }] }),
                })
            ).status,
        ).toBe(200);

        // The avatar lives in data/server/avatars, outside the home folder, so it is the archive's
        // job to carry it — nothing else would bring it back with a deleted user.
        avatarPath = join(getAvatarsDir(), `${deleted.id}.webp`);
        await Bun.write(avatarPath, TEST_PNG_BYTES);

        artifact = await backup(deleted.id, new Date());
    });

    test('re-inserts the auth and share rows, and the user can sign in again', async () => {
        const del = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${deleted.id}`, {
            method: 'DELETE',
        });
        expect(del.status).toBe(200);
        expect(existsSync(join(TEST_DATA_DIR, 'home', deleted.id))).toBe(false);
        const authDb = getAuthDrizzleDb();
        expect(authDb.select().from(userScheme).where(eq(userScheme.id, deleted.id)).all()).toEqual([]);

        await restoreHome(artifact, deleted.id, `restore-deleted-${Date.now()}`);

        expect(authDb.select().from(userScheme).where(eq(userScheme.id, deleted.id)).all().length).toBe(1);
        const shares = (await getEigenDb())
            .select()
            .from(shareRegistry)
            .where(eq(shareRegistry.fromUserId, deleted.id))
            .all();
        expect(shares.map((row) => row.targetIdentifier)).toEqual([SHARE_TARGET]);

        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email: deleted.email, password: PASSWORD },
        });
        const token = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
        expect(token).toBeTruthy();
        expect(await rootNames(token![1], deleted.id, mountId, rootId)).toEqual([CHATS_FOLDER, 'gone-with-me.png']);

        // Deleting the user took the avatar with it; the archive puts it back.
        expect(existsSync(avatarPath)).toBe(true);
        expect(new Uint8Array(await Bun.file(avatarPath).arrayBuffer())).toEqual(TEST_PNG_BYTES);
    });

    test('leaves an avatar the server already has alone', async () => {
        // A picture the user changed after the backup is theirs, and a restore of their files is not
        // a reason to revert it.
        const newer = new TextEncoder().encode('a picture chosen after the backup');
        await Bun.write(avatarPath, newer);

        await restoreHome(artifact, deleted.id, `restore-avatar-${Date.now()}`);

        expect(new Uint8Array(await Bun.file(avatarPath).arrayBuffer())).toEqual(newer);
    });
});

describe('Backup restore when an auth row cannot be re-inserted', () => {
    test('the whole identity rolls back, so a retry is not locked out by a half-inserted user', async () => {
        const ctx = await getTestContext();
        const user = await createTestUser('restore-authclash@test.eigen.is', PASSWORD, 'Restore Auth Clash');
        await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`);
        const apiKeyId = (await auth.api.createApiKey({
            body: { name: 'restore-app-password' },
            headers: { cookie: `better-auth.session_token=${user.sessionToken}` },
        }))!.id;
        const artifact = await backup(user.id, new Date());

        expect(
            (await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${user.id}`, { method: 'DELETE' }))
                .status,
        ).toBe(200);
        const authDb = getAuthDrizzleDb();
        // Somebody else's row already holds the id the archive wants to insert: the user row goes in
        // first, this one clashes on the primary key, and without one transaction the restore would
        // leave a user that exists but has no password row — and every retry would see that user and
        // return early, never trying again.
        authDb
            .insert(apikeyScheme)
            .values({
                id: apiKeyId,
                configId: 'clash',
                referenceId: ctx.alice.user.id,
                key: 'clash',
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run();

        await expect(restoreHome(artifact, user.id, `restore-clash-${Date.now()}`)).rejects.toThrow();

        expect(authDb.select().from(userScheme).where(eq(userScheme.id, user.id)).all()).toEqual([]);
        authDb.delete(apikeyScheme).where(eq(apikeyScheme.id, apiKeyId)).run();
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore of a team home', () => {
    // The primitive is owner-kind-agnostic, and a team home is the other half of what it covers:
    // no auth rows, no mail, no contacts — one calendar and the mounts an admin gave it.
    let ctx: TestCtx;
    let ownerId: string;
    let mountId: string;
    let rootId: string;
    let fileId: string;
    let artifact: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, `Restore Team ${Date.now()}`);
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addTeamMount(ctx, teamId, 'Team Restore Files');
        ownerId = teamOwnerId(teamId);
        const token = ctx.alice.user.sessionToken;
        mountId = await firstMountId(token, ownerId);
        rootId = (await assertJson<DrivePath>(await authedRequest(token, `/drive/${ownerId}/${mountId}/root`))).id;
        fileId = (
            await driveUpload<DrivePath>(
                token,
                ownerId,
                mountId,
                rootId,
                new File([TEST_PNG_BYTES], 'team-file.png', { type: 'image/png' }),
            )
        ).id;
        artifact = await backup(ownerId, new Date());
    });

    test('round-trips the team home, files and all', async () => {
        const token = ctx.alice.user.sessionToken;
        await driveUpload(
            token,
            ownerId,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'after-the-team-backup.png', { type: 'image/png' }),
        );
        expect(await rootNames(token, ownerId, mountId, rootId)).toContain('after-the-team-backup.png');

        await restoreHome(artifact, ownerId, `restore-team-${Date.now()}`);

        const names = await rootNames(token, ownerId, mountId, rootId);
        expect(names).toContain('team-file.png');
        expect(names).not.toContain('after-the-team-backup.png');
        const download = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${fileId}/download`);
        expect(download.status).toBe(200);
        expect(new Uint8Array(await download.arrayBuffer())).toEqual(TEST_PNG_BYTES);

        // The state before it is beside the team home, under the team folder's own name.
        const teamRoot = join(TEST_DATA_DIR, 'team');
        const copies = readdirSync(teamRoot).filter((name) => name.startsWith(`${ownerId.slice('team_'.length)}.`));
        expect(copies.length).toBe(1);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore over a live user', () => {
    // A restore puts a home's data back; it never rewrites who somebody is. An id whose email no
    // longer matches the archive is a different person, and their home is not this archive's to
    // replace.
    test('refuses when the email no longer matches the archive, and puts the home back', async () => {
        const user = await createTestUser('restore-email@test.eigen.is', PASSWORD, 'Restore Email');
        const mountId = await firstMountId(user.sessionToken, user.id);
        const rootId = (
            await assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`))
        ).id;
        await driveUpload(
            user.sessionToken,
            user.id,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'still-mine.png', { type: 'image/png' }),
        );
        const artifact = await backup(user.id, new Date());
        const before = await rootNames(user.sessionToken, user.id, mountId, rootId);

        getAuthDrizzleDb()
            .update(userScheme)
            .set({ email: 'someone-else@test.eigen.is' })
            .where(eq(userScheme.id, user.id))
            .run();

        await expect(restoreHome(artifact, user.id, `restore-email-${Date.now()}`)).rejects.toThrow(
            /is now someone-else@test.eigen.is; the archive holds restore-email@test.eigen.is/,
        );

        // The identity write is the last step, so the rollback undoes everything before it.
        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX).length).toBe(1);
        expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toEqual(before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore of the avatar', () => {
    // The avatar is the one file a restore writes outside the home folder, into the server-wide
    // avatars directory, and its name comes out of the archive.
    test("plants nothing for another user, and puts this user's own picture back", async () => {
        const user = await createTestUser('restore-avatar@test.eigen.is', PASSWORD, 'Restore Avatar');
        await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`);
        const own = join(getAvatarsDir(), `${user.id}.webp`);
        await Bun.write(own, TEST_PNG_BYTES);

        const foreign = `${'f'.repeat(32)}`;
        const foreignBytes = new TextEncoder().encode('a picture for somebody else');
        const artifact = await backup(user.id, new Date(), async (manifest, folder) => {
            const planted = `${ARCHIVE_AVATAR_DIR}/${foreign}.webp`;
            await Bun.write(join(folder, planted), foreignBytes);
            const hasher = new Bun.CryptoHasher('sha256');
            hasher.update(foreignBytes);
            manifest.entries.push({
                path: planted,
                bytes: foreignBytes.byteLength,
                sha256: hasher.digest('hex'),
            });
        });
        rmSync(own, { force: true });

        await restoreHome(artifact, user.id, `restore-avatar-${Date.now()}`);

        expect(existsSync(own)).toBe(true);
        expect(new Uint8Array(await Bun.file(own).arrayBuffer())).toEqual(TEST_PNG_BYTES);
        expect(existsSync(join(getAvatarsDir(), `${foreign}.webp`))).toBe(false);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore of a disabled mount', () => {
    // A mount an admin turned off is not in the drive's map: a snapshot that walked the live mounts
    // alone left its folder out of the archive entirely, and the restore then dropped it for good.
    const DISABLED_MOUNT_ID = 'restore-disabled';
    const SKIPPED_MOUNT_ID = 'restore-skipped';
    const PASSIVE_MOUNT_ID = 'restore-passive';

    beforeAll(async () => {
        await getTestContext();
    });

    test('a disabled mount comes back with its files, still disabled', async () => {
        const user = await createTestUser('restore-disabled@test.eigen.is', PASSWORD, 'Restore Disabled');
        const home = await getHome(user.id);
        const on = await home.settings.set({
            mounts: {
                [DISABLED_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Archive Mount' },
            },
        });
        await home.drive.addMount(createMountConfig(DISABLED_MOUNT_ID, on.mounts![DISABLED_MOUNT_ID]));
        const root = await assertJson<DrivePath>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/${DISABLED_MOUNT_ID}/root`),
        );
        await driveUpload<DrivePath>(
            user.sessionToken,
            user.id,
            DISABLED_MOUNT_ID,
            root.id,
            new File([TEST_PNG_BYTES], 'archived.png', { type: 'image/png' }),
        );

        const off = await home.settings.set({
            mounts: { [DISABLED_MOUNT_ID]: { ...on.mounts![DISABLED_MOUNT_ID], enabled: false } },
        });
        await home.drive.updateMount(createMountConfig(DISABLED_MOUNT_ID, off.mounts![DISABLED_MOUNT_ID]), false);

        const artifact = await backup(user.id, new Date());
        const mountDir = join(TEST_DATA_DIR, 'home', user.id, 'mounts', DISABLED_MOUNT_ID);
        // Only what the archive carries can put the folder back.
        rmSync(mountDir, { recursive: true, force: true });

        await restoreHome(artifact, user.id, `restore-disabled-${Date.now()}`);
        rmSync(join(getBackupsDir(), artifact), { force: true });

        expect(existsSync(join(mountDir, 'metadata.db'))).toBe(true);
        expect(existsSync(join(mountDir, 'data', 'archived.png'))).toBe(true);
        // Still off: settings.json rides along as it stood, so the restored home serves what it did.
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
        );
        expect(mounts.map((mount) => mount.id)).not.toContain(DISABLED_MOUNT_ID);
    });

    // The other half of the ruling: an ENABLED mount whose storage is unreachable still fails the
    // backup loudly, but a disabled one must not — its bucket is often unreachable BECAUSE an admin
    // turned it off, and that would leave the home with no backup at all.
    test('a disabled mount whose storage is unreachable is skipped, not a failure', async () => {
        const user = await createTestUser('restore-skipped@test.eigen.is', PASSWORD, 'Restore Skipped');
        const home = await getHome(user.id);
        const on = await home.settings.set({
            mounts: { [SKIPPED_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Offline' } },
        });
        await home.drive.addMount(createMountConfig(SKIPPED_MOUNT_ID, on.mounts![SKIPPED_MOUNT_ID]));
        const root = await assertJson<DrivePath>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/${SKIPPED_MOUNT_ID}/root`),
        );
        await driveUpload<DrivePath>(
            user.sessionToken,
            user.id,
            SKIPPED_MOUNT_ID,
            root.id,
            new File([TEST_PNG_BYTES], 'unreachable.png', { type: 'image/png' }),
        );

        // Turned off and pointed at a bucket nothing answers: what a mount an admin disabled after
        // its storage died looks like on the next backup.
        const off = await home.settings.set({
            mounts: {
                [SKIPPED_MOUNT_ID]: {
                    ...on.mounts![SKIPPED_MOUNT_ID],
                    storageType: 's3',
                    enabled: false,
                    s3Config: {
                        endpoint: 'http://127.0.0.1:1',
                        bucket: 'nowhere',
                        prefix: '',
                        accessKeyId: 'x',
                        secretAccessKey: 'y',
                    },
                },
            },
        });
        await home.drive.updateMount(createMountConfig(SKIPPED_MOUNT_ID, off.mounts![SKIPPED_MOUNT_ID]), false);

        let manifest: BackupManifest | undefined;
        const artifact = await backup(user.id, new Date(), (written) => {
            manifest = written;
        });
        const summary = manifest?.mounts.find((mount) => mount.id === SKIPPED_MOUNT_ID);
        expect(summary?.skipped).toContain('storage unreachable');
        expect(summary?.files).toBe(0);

        // The archive holds nothing for it, so the restore's own verify passes and the mount is
        // simply not in the home it installs.
        await restoreHome(artifact, user.id, `restore-skipped-${Date.now()}`);
        rmSync(join(getBackupsDir(), artifact), { force: true });

        expect(existsSync(join(TEST_DATA_DIR, 'home', user.id, 'mounts', SKIPPED_MOUNT_ID))).toBe(false);
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
        );
        expect(mounts.map((mount) => mount.id)).not.toContain(SKIPPED_MOUNT_ID);
    });

    // A disabled mount is archived through the same Mount an enabled one is, opened passively —
    // and a backup is not what turns a mount an admin switched off back on. `tmp/` is the tell: a
    // normal open creates it, along with the sweeps and purges that follow (Mount.init).
    test('archiving a disabled mount writes nothing into its folder', async () => {
        const user = await createTestUser('restore-passive@test.eigen.is', PASSWORD, 'Restore Passive');
        const home = await getHome(user.id);
        const on = await home.settings.set({
            mounts: {
                [PASSIVE_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Passive Mount' },
            },
        });
        await home.drive.addMount(createMountConfig(PASSIVE_MOUNT_ID, on.mounts![PASSIVE_MOUNT_ID]));
        const root = await assertJson<DrivePath>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/${PASSIVE_MOUNT_ID}/root`),
        );
        await driveUpload<DrivePath>(
            user.sessionToken,
            user.id,
            PASSIVE_MOUNT_ID,
            root.id,
            new File([TEST_PNG_BYTES], 'passive.png', { type: 'image/png' }),
        );
        const off = await home.settings.set({
            mounts: { [PASSIVE_MOUNT_ID]: { ...on.mounts![PASSIVE_MOUNT_ID], enabled: false } },
        });
        await home.drive.updateMount(createMountConfig(PASSIVE_MOUNT_ID, off.mounts![PASSIVE_MOUNT_ID]), false);

        const mountDir = join(TEST_DATA_DIR, 'home', user.id, 'mounts', PASSIVE_MOUNT_ID);
        rmSync(join(mountDir, 'tmp'), { recursive: true, force: true });

        const artifact = await backup(user.id, new Date());
        rmSync(join(getBackupsDir(), artifact), { force: true });

        expect(existsSync(join(mountDir, 'tmp'))).toBe(false);
    });
});
