import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_HOME_REPLACED_CLOSE } from '@workspace/lib/constants/collab';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { apikey as apikeyScheme, user as userScheme } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import {
    buildArtifactName,
    buildHomeFolderName,
    FAILED_RESTORE_SUFFIX,
    getBackupsDir,
    PRE_RESTORE_SUFFIX,
} from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import { paths } from '../../lib/mount/schema';
import { getEigenDb } from '../../lib/share/db';
import { shareRegistry } from '../../lib/share/schema';
import { createHomeFaultMount, registerFaultMount, unregisterFaultMount } from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    driveGetList,
    drivePost,
    driveUpload,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
type TestUser = { id: string; email: string; sessionToken: string };

const PASSWORD = 'testpassword123';
// A share to an address with no account is what writes a share_registry row (acl-propagation.ts).
const SHARE_TARGET = 'restore-outsider@external.test';
// Every home's drive root holds this folder from the start; it rides along in every listing below.
const CHATS_FOLDER = 'chats';
// A second mount on the path-based backend: its archive tree IS its storage layout, and its empty
// folders exist only in the paths table. The harness's default mount is local-key (setup uses
// 'local-id'), so both key shapes are restored here.
const LOCAL_MOUNT_ID = 'restore-local';

async function createUser(email: string, name: string): Promise<TestUser> {
    const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
    const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`no session cookie for ${email}`);
    return { id: signUp.user.id, email, sessionToken: match[1] };
}

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
    const db = new Database(join(TEST_DATA_DIR, 'home', ownerId, 'mounts', mountId, 'metadata.db'), {
        readwrite: true,
        create: false,
    });
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
    let port: number;

    beforeAll(async () => {
        ctx = await getTestContext();
        target = await createUser('restoreme@test.eigen.is', 'Restore Me');

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
        user = await createUser('restore-schema@test.eigen.is', 'Restore Schema');
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
        const doomed = await createUser('restore-schema-deleted@test.eigen.is', 'Restore Schema Deleted');
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

    beforeAll(async () => {
        ctx = await getTestContext();
        deleted = await createUser('restore-deleted@test.eigen.is', 'Restore Deleted');
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
    });
});

describe('Backup restore when an auth row cannot be re-inserted', () => {
    test('the whole identity rolls back, so a retry is not locked out by a half-inserted user', async () => {
        const ctx = await getTestContext();
        const user = await createUser('restore-authclash@test.eigen.is', 'Restore Auth Clash');
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
