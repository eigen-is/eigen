import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_HOME_REPLACED_REASON,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_REASON,
} from '@workspace/lib/constants/collab';
import { teamOwnerId } from '@workspace/lib/types';
import type { BackupLevel, BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { apikey as apikeyScheme, session as sessionScheme, user as userScheme } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import * as archiveModule from '../../lib/backup/archive';
import { extractArtifact, packFolder, readArtifactManifest } from '../../lib/backup/archive';
import { MAILDIR_ROOT } from '../../lib/backup/archive-layout';
import { runHomeBackup, startBackupJob } from '../../lib/backup/jobs';
import * as materializeModule from '../../lib/backup/materialize-mount';
import * as pathsModule from '../../lib/backup/paths';
import {
    ARCHIVE_AVATAR_DIR,
    ARCHIVE_SHARES_FILE,
    buildHomeFolderName,
    buildRestoreStagingDir,
    freeArtifactName,
    getBackupsDir,
    isRestoreStagingName,
} from '../../lib/backup/paths';
import * as recoveryModule from '../../lib/backup/recovery';
import { recoverBackupsAfterRestart } from '../../lib/backup/recovery';
import { restoreHome, restoreSafetyCopy } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import * as verifyModule from '../../lib/backup/verify';
import { getAvatarsDir, getDataRoot, PATHS } from '../../lib/config/paths';
import { getServerConfig } from '../../lib/config/server-config';
import { avatarNameOf } from '../../lib/contacts/card-store';
import { ApiError } from '../../lib/core';
import type { Home } from '../../lib/home';
import * as dataEpochModule from '../../lib/home/data-epoch';
import { getDataEpoch } from '../../lib/home/data-epoch';
import { clearHomeRestoring, evictHome, getHome, loadedHome, markHomeRestoring } from '../../lib/home/get-home';
import { createSSEStream } from '../../lib/home/sse-stream';
import { createMountConfig } from '../../lib/mount';
import { paths } from '../../lib/mount/schema';
import { getEigenDb } from '../../lib/share/db';
import * as registryModule from '../../lib/share/registry';
import { shareRegistry } from '../../lib/share/schema';
import { saveThumbnail } from '../../lib/shared/thumbnails';
import { createHomeFaultMount, registerFaultMount, unregisterFaultMount } from '../fault-storage-helpers';
import { seedFile } from '../mount-test-helpers';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    countLoopTurns,
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
} from '../setup';
import { expectRealShape, expectRealShapeServed, realShapeHome, waitForJob } from './backup-test-helpers';

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
// its own entry (restateEntry) to get past verify and be judged by the step under test. `level` is
// a capture mode of the whole-server archive; left out, it is the per-home backup the pane runs.
async function backup(
    userId: string,
    at: Date,
    patch?: (manifest: BackupManifest, folder: string) => Promise<void> | void,
    level?: BackupLevel,
): Promise<string> {
    const home = await getHome(userId);
    const staging = mkdtempSync(join(TEST_DATA_DIR, 'restore-backup-'));
    const folder = join(staging, buildHomeFolderName(userId));
    const manifest = await snapshotHome(home, staging, { level });
    if (patch) {
        await patch(manifest, folder);
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    const name = freeArtifactName(userId, at);
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

// One open tab's event stream. `announced` reads on to the next data epochs it announces: the one it opens with, then
// one per keepalive, which the fake timers of the tests below bring forward.
async function openEventStream(userId: string) {
    const session = getAuthDrizzleDb().select().from(sessionScheme).where(eq(sessionScheme.userId, userId)).get();
    if (!session) throw new Error(`${userId} has no session`);
    const reader = createSSEStream(await getHome(userId), session.id).getReader();
    return {
        announced: async (): Promise<Record<string, string>> => {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) throw new Error(`The stream of ${userId} ended`);
                if (value && 'type' in value && value.type === SSEventType.HOME_DATA_EPOCHS) return value.epochs;
            }
        },
        // Reads on to the end, which comes when the stream's Home closes.
        ended: async (): Promise<void> => {
            while (!(await reader.read()).done) {}
        },
        close: () => reader.cancel(),
    };
}

function safetyCopies(userId: string, suffix: string): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter((name) => name.startsWith(`${userId}${suffix}`));
}

function removeSafetyCopies(userId: string): void {
    for (const name of safetyCopies(userId, '.')) {
        rmSync(join(TEST_DATA_DIR, 'home', name), { recursive: true, force: true });
    }
}

// The folders a per-home restore unpacks into beside the homes. Its job removes its own however it ends.
function restoreStagingFolders(): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter(isRestoreStagingName);
}

// What a restore refused before it takes the home leaves as it was: the loaded home, every safety copy beside it, and
// the data epoch its tabs reload on.
async function untakenState(userId: string) {
    return { home: await getHome(userId), copies: safetyCopies(userId, '.'), epoch: getDataEpoch(userId) };
}

// Never evicted, nothing moved aside or parked, no tab told to reload.
async function expectNotTaken(userId: string, before: Awaited<ReturnType<typeof untakenState>>): Promise<void> {
    const after = await untakenState(userId);
    expect(after.home).toBe(before.home);
    expect(after.copies).toEqual(before.copies);
    expect(after.epoch).toBe(before.epoch);
    expect(restoreStagingFolders()).toEqual([]);
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
    let avatarPath: string;
    let avatarName: string;
    let avatarBytes: Uint8Array<ArrayBuffer>;
    let animatedAvatarPath: string;
    let animatedAvatarName: string;
    let animatedAvatarBytes: Uint8Array<ArrayBuffer>;
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
        await authedRequest(target.sessionToken, `/mail/${target.id}/mailbox/inbox`);

        const home = await getHome(target.id);
        // A contact photo: the derived webp is written once, at the card write, from the pristine upload,
        // so a restore has to bring those very bytes back the way it brings a thumbnail back.
        const staged = await home.contacts.uploadAvatar(
            new File([TEST_PNG_BYTES], 'avatar.png', { type: 'image/png' }),
        );
        const photoContactId = await home.contacts.addContact({
            firstName: 'Photo',
            lastName: 'Contact',
            email: ['photo@test.eigen.is'],
            phone: [],
            avatar: staged,
        });
        const photoContact = await home.contacts.getContactById(photoContactId);
        avatarName = avatarNameOf(photoContact?.avatar ?? '');
        expect(avatarName).toEndWith('.webp');
        avatarPath = join(TEST_DATA_DIR, 'home', target.id, 'eigen.contacts', 'avatars', avatarName);
        avatarBytes = new Uint8Array(await Bun.file(avatarPath).arrayBuffer());

        // A second photo, animated: its cache is a multi-frame webp, which a tar that re-encodes anything —
        // or a restore that writes the stream back frame by frame — would flatten.
        const sharp = (await import('sharp')).default;
        const frames = await Promise.all(
            [
                { r: 220, g: 20, b: 20 },
                { r: 20, g: 220, b: 20 },
                { r: 20, g: 20, b: 220 },
            ].map((background) =>
                sharp({ create: { width: 32, height: 32, channels: 3, background } })
                    .png()
                    .toBuffer(),
            ),
        );
        const gif = await sharp(frames, { join: { animated: true } })
            .gif()
            .toBuffer();
        const animatedContactId = await home.contacts.addContact({
            firstName: 'Animated',
            lastName: 'Contact',
            email: ['animated@test.eigen.is'],
            phone: [],
            avatar: await home.contacts.uploadAvatar(
                new File([new Uint8Array(gif)], 'animated.gif', { type: 'image/gif' }),
            ),
        });
        animatedAvatarName = avatarNameOf((await home.contacts.getContactById(animatedContactId))?.avatar ?? '');
        animatedAvatarPath = join(TEST_DATA_DIR, 'home', target.id, 'eigen.contacts', 'avatars', animatedAvatarName);
        animatedAvatarBytes = new Uint8Array(await Bun.file(animatedAvatarPath).arrayBuffer());
        expect((await sharp(animatedAvatarBytes, { animated: true }).metadata()).pages).toBe(3);
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
        await authedRequest(target.sessionToken, `/mail/${target.id}/mailbox/inbox`);
        // ...and lose the thumbnail and the contact photo nothing would ever generate again.
        rmSync(keptThumbPath, { force: true });
        rmSync(avatarPath, { force: true });
        rmSync(animatedAvatarPath, { force: true });
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

        // The contact photo cache is derived at the write alone, so the archive is the only copy left —
        // and it comes back as the very bytes the upload was encoded to, not a re-derivation.
        const restoredAvatar = await home.contacts.downloadAvatar(avatarName);
        expect(restoredAvatar).not.toBeNull();
        expect(new Uint8Array(restoredAvatar!)).toEqual(avatarBytes);

        // The animated cache comes back frame for frame, because the archive copies bytes and never re-encodes.
        const restoredAnimated = await home.contacts.downloadAvatar(animatedAvatarName);
        expect(restoredAnimated).not.toBeNull();
        expect(new Uint8Array(restoredAnimated!)).toEqual(animatedAvatarBytes);

        const [preRestore] = safetyCopies(target.id, PRE_RESTORE_SUFFIX);
        expect(preRestore).toBeTruthy();
        expect(mailSubjectsIn(join(TEST_DATA_DIR, 'home', preRestore))).toContain('After the backup');
    });

    // How a collab socket opened now, naming `query`, is closed.
    function collabClose(query: string): Promise<{ code: number; reason: string }> {
        const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${target.id}/${mountId}/${docId}${query}`, {
            headers: { cookie: `better-auth.session_token=${target.sessionToken}` },
        } as unknown as string[]);
        return new Promise((resolve, reject) => {
            ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
            ws.onerror = (event) => reject(event);
        });
    }

    // The socket retries through the restore; the reconnect after it names the old epoch, so only a restore that
    // rotated it reloads the tab, once.
    test('an open collab socket is closed with the retry close, and its reconnect after the restore with 1012', async () => {
        const epoch = getDataEpoch(target.id);
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

        expect(await closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
        });
        expect(await collabClose(`?epoch=${epoch}`)).toEqual({
            code: COLLAB_HOME_REPLACED_CLOSE,
            reason: COLLAB_HOME_REPLACED_REASON,
        });
    });

    // Every tab of this home reloads on the new epoch, connected or offline through the restore; no other home's does.
    test('draws a new data epoch for this home alone, so only its tabs reload', async () => {
        const before = getDataEpoch(target.id);
        const other = getDataEpoch(ctx.alice.user.id);
        await restoreHome(artifact, target.id, `restore-epoch-${Date.now()}`);
        expect(getDataEpoch(target.id)).not.toBe(before);
        expect(getDataEpoch(ctx.alice.user.id)).toBe(other);
    });

    // Every tab of the owner reloads, whatever app it shows. The restore ends each open stream with the home it held,
    // and the stream the tab opens again announces the new epoch. Nobody else's stream names the home at all.
    test("the owner's streams end and reconnect to the new epoch, and another user's never name the home", async () => {
        jest.useFakeTimers();
        const owner = await openEventStream(target.id);
        const other = await openEventStream(ctx.alice.user.id);
        try {
            const before = await owner.announced();
            const otherBefore = await other.announced();
            expect(Object.keys(otherBefore)).not.toContain(target.id);

            await restoreHome(artifact, target.id, `restore-sse-${Date.now()}`);
            await owner.ended();
            const reconnected = await openEventStream(target.id);
            const after = await reconnected.announced();
            await reconnected.close();
            expect(after[target.id]).not.toBe(before[target.id]);
            expect(after[target.id]).toBe(getDataEpoch(target.id));

            // A stream on a home the restore never touched stays open, and its keepalive names the same epochs.
            jest.advanceTimersByTime(15_000);
            expect(await other.announced()).toEqual(otherBefore);
        } finally {
            jest.useRealTimers();
            await owner.close();
            await other.close();
        }
    });

    test('a socket that connects while the mark is set is closed with the retry close, never 1012', async () => {
        const epoch = getDataEpoch(target.id);
        markHomeRestoring(target.id);
        try {
            // 1012 would reload the tab onto the 503 of the restore, and throw away its edits if the restore fails.
            expect(await collabClose(`?epoch=${epoch}`)).toEqual({
                code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
                reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
            });
        } finally {
            clearHomeRestoring(target.id);
        }
    });

    test('a second restore of one home is refused and touches nothing', async () => {
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

    test('an empty path-based folder whose name and file differ comes back where its mount renames it from', async () => {
        const home = await getHome(target.id);
        const localMount = home.drive.getMounts().find((m) => m.id === LOCAL_MOUNT_ID)!;
        const folder = await drivePost(target.sessionToken, target.id, LOCAL_MOUNT_ID, `folder/${localRootId}`, {
            folderName: 'Deduplicated',
        });
        await localMount.db.update(paths).set({ name: 'Deduplicated (1)' }).where(eq(paths.id, folder.id));

        const artifactV7 = await backup(target.id, new Date(Date.now() + 180_000));
        await restoreHome(artifactV7, target.id, `restore-renamed-folder-${Date.now()}`);

        const rename = await authedRequest(
            target.sessionToken,
            `/drive/${target.id}/${LOCAL_MOUNT_ID}/path/${folder.id}/rename`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newName: 'Kept' }),
            },
        );
        expect(rename.status).toBe(200);
        rmSync(join(getBackupsDir(), artifactV7), { force: true });
    });

    test('the home is refused while the mark is set and served again once it clears', async () => {
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

    test('a name that is no archive, or an archive that is not there, is refused before anything is touched', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const copies = safetyCopies(target.id, PRE_RESTORE_SUFFIX).length;
        await expect(
            restoreHome('not-an-archive.tar.zst', target.id, `restore-badname-${Date.now()}`),
        ).rejects.toMatchObject({
            status: 400,
            message: 'Not a backup artifact name',
        });
        const missing = freeArtifactName(target.id, new Date(Date.UTC(2001, 0, 1)));
        await expect(restoreHome(missing, target.id, `restore-missing-${Date.now()}`)).rejects.toMatchObject({
            status: 404,
            message: 'Artifact not found',
        });
        expect(safetyCopies(target.id, PRE_RESTORE_SUFFIX).length).toBe(copies);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // A note the next boot finds means a restore to undo. It lives in the folder the job staged beside the home, on the
    // home's disk, and nothing goes to the backups folder. Every restore removes that folder on its way out, so the wipe
    // is held off here to look at what is left.
    test('a finished restore leaves no marker beside the home', async () => {
        const jobId = `restore-sentinel-${Date.now()}`;
        const spy = spyOn(recoveryModule, 'wipeRestoreStagingDir').mockImplementation(async () => {});
        try {
            await restoreHome(artifact, target.id, jobId);
        } finally {
            spy.mockRestore();
        }

        const staging = buildRestoreStagingDir(join(TEST_DATA_DIR, 'home', target.id), jobId);
        expect(existsSync(staging)).toBe(true);
        expect(existsSync(join(staging, 'restoring.json'))).toBe(false);
        expect(existsSync(join(getBackupsDir(), '.staging', jobId))).toBe(false);
        rmSync(staging, { recursive: true, force: true });
    });

    test('a mount the archive promises and carries no metadata.db for is refused before the home is taken', async () => {
        // Verify passes it: it reads entries, and the manifest itself is not hashed.
        const doctored = await backup(target.id, new Date(Date.now() + 60_000), (manifest) => {
            manifest.mounts.push({ id: 'ghost-mount', storageType: 'local', files: 0, bytes: 0 });
        });
        const before = await untakenState(target.id);

        await expect(restoreHome(doctored, target.id, `restore-ghost-${Date.now()}`)).rejects.toThrow(/ghost-mount/);

        await expectNotTaken(target.id, before);
        rmSync(join(getBackupsDir(), doctored), { force: true });
    });

    test('a mount that cannot be put in place refuses the restore before the home is taken', async () => {
        const before = await untakenState(target.id);
        const spy = spyOn(materializeModule, 'materializeMount').mockImplementation(() => {
            throw new ApiError(500, 'failed by the test');
        });
        try {
            await expect(restoreHome(artifact, target.id, `restore-materialize-${Date.now()}`)).rejects.toThrow(
                'failed by the test',
            );
        } finally {
            spy.mockRestore();
        }

        await expectNotTaken(target.id, before);
    });

    test('a failure after the move-aside leaves .failed-restore and puts the original back', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const failedBefore = safetyCopies(target.id, FAILED_RESTORE_SUFFIX).length;
        // After the new home folder moved in, so a new folder is in place when it throws.
        const spy = spyOn(dataEpochModule, 'rotateHomeDataEpoch').mockImplementation(async () => {
            throw new ApiError(500, 'failed by the test');
        });
        try {
            await expect(restoreHome(artifact, target.id, `restore-rollback-${Date.now()}`)).rejects.toThrow(
                'failed by the test',
            );
        } finally {
            spy.mockRestore();
        }

        expect(safetyCopies(target.id, FAILED_RESTORE_SUFFIX).length).toBe(failedBefore + 1);
        expect(existsSync(join(TEST_DATA_DIR, 'home', target.id))).toBe(true);
        expect(restoreStagingFolders()).toEqual([]);
        // The mark is cleared, so the home serves again — from the folder that was put back.
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // The rotation comes after the install, so a failed install never reaches it and the tabs sync the edits they hold.
    test('a failed install leaves the data epoch as it was', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const homeDir = join(TEST_DATA_DIR, 'home', target.id);
        const epoch = getDataEpoch(target.id);
        const rename = nodeFs.renameSync;
        const spy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            // The install's move of the unpacked folder, which the rollback's move of the original is not.
            if (to === homeDir && !String(from).includes(PRE_RESTORE_SUFFIX)) throw new Error('install failed');
            rename(from, to);
        });
        try {
            await expect(restoreHome(artifact, target.id, `restore-install-${Date.now()}`)).rejects.toThrow(
                'install failed',
            );
        } finally {
            spy.mockRestore();
        }

        expect(getDataEpoch(target.id)).toBe(epoch);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // Accepted: the original home is back under a new epoch, so its tabs reload once.
    test('a note that cannot be removed after the rotation leaves the epoch rotated', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const epoch = getDataEpoch(target.id);
        const spy = spyOn(recoveryModule, 'dropRestoringMarker').mockImplementation(() => {
            throw new Error('failed by the test');
        });
        try {
            await expect(restoreHome(artifact, target.id, `restore-note-${Date.now()}`)).rejects.toThrow(
                'failed by the test',
            );
        } finally {
            spy.mockRestore();
        }

        expect(getDataEpoch(target.id)).not.toBe(epoch);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // A rollback that could not put the home back leaves it aside, and only the notes tell the next boot where. So the
    // job keeps them, and the boot finishes the rollback.
    test('a rollback that fails keeps the notes, and the boot puts the home back', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const homeDir = join(TEST_DATA_DIR, 'home', target.id);
        const jobId = `restore-rollback-fails-${Date.now()}`;
        const epochSpy = spyOn(dataEpochModule, 'rotateHomeDataEpoch').mockImplementation(async () => {
            throw new Error('failed by the test');
        });
        const rename = nodeFs.renameSync;
        const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            // The rollback's first move, the new folder aside.
            if (from === homeDir && String(to).includes(FAILED_RESTORE_SUFFIX)) throw new Error('rename failed');
            rename(from, to);
        });
        try {
            const failed = await restoreHome(artifact, target.id, jobId).catch((error: unknown) => error);
            // A failure that is not an ApiError is the server's own.
            expect(failed instanceof ApiError && failed.status).toBe(500);
            expect(failed instanceof Error && failed.message).toContain('failed by the test');
        } finally {
            epochSpy.mockRestore();
            renameSpy.mockRestore();
        }

        const staging = buildRestoreStagingDir(homeDir, jobId);
        expect(existsSync(join(staging, 'restoring.json'))).toBe(true);
        await recoverBackupsAfterRestart();
        expect(restoreStagingFolders()).toEqual([]);
        // The restart that ran the recovery starts with no home marked.
        clearHomeRestoring(target.id);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });

    // The rollback parked the new folder and then could not put the home back, so the home's path is empty. A
    // request that opened the home there would make a new, empty home folder, and the boot could then not park it
    // under the name the rollback already took. So the home answers 503 until the restart puts it back.
    test('a home the rollback left out of place serves nothing until the boot puts it back', async () => {
        const before = await rootNames(target.sessionToken, target.id, mountId, rootId);
        const homeDir = join(TEST_DATA_DIR, 'home', target.id);
        const epochSpy = spyOn(dataEpochModule, 'rotateHomeDataEpoch').mockImplementation(async () => {
            throw new ApiError(409, 'failed by the test');
        });
        const rename = nodeFs.renameSync;
        const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            // The rollback's second move, the home back into place.
            if (to === homeDir && String(from).includes(PRE_RESTORE_SUFFIX)) throw new Error('rename failed');
            rename(from, to);
        });
        try {
            const failed = await restoreHome(artifact, target.id, `restore-left-aside-${Date.now()}`).catch(
                (error: unknown) => error,
            );
            // The admin sees only the job's error, so it says why the home answers 503 and what puts it back. The
            // first failure's status stays, so a refusal is not reported as the server's fault.
            expect(failed instanceof ApiError && failed.status).toBe(409);
            expect(failed instanceof Error && failed.message).toBe(
                'failed by the test, and the home could not be put back. The account is shut until Eigen restarts, which puts it back: run ./eigen stop, then ./eigen restart',
            );
        } finally {
            epochSpy.mockRestore();
            renameSpy.mockRestore();
        }

        expect((await authedRequest(target.sessionToken, `/drive/${target.id}/mounts`)).status).toBe(503);
        expect(existsSync(homeDir)).toBe(false);
        await recoverBackupsAfterRestart();
        clearHomeRestoring(target.id);
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
    });
});

describe('Backup restore refuses an archive this server cannot open', () => {
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

    test('verify fails a database from a newer server, naming both versions', async () => {
        const staging = mkdtempSync(join(TEST_DATA_DIR, 'restore-newer-verify-'));
        const folder = join(staging, buildHomeFolderName(user.id));
        const manifest = await snapshotHome(await getHome(user.id), staging);
        await stampSchemaVersion(manifest, folder, 'home/eigen.mail/mail.db', 999);
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));

        const record = await verifyModule.verifyFolder(folder);

        expect(record.status).toBe('failed');
        expect(record.failures.join(' ')).toContain('at mail schema v999, newer than this server supports');
        rmSync(staging, { recursive: true, force: true });
    });

    test('a database from a newer server is refused before the home is taken', async () => {
        const names = await rootNames(user.sessionToken, user.id, mountId, rootId);
        // quick_check would pass this file; ManagedDatabase's forward-version guard would not, and it
        // fails the WHOLE home on the next load — long after the job said the restore was done.
        const artifact = await backup(user.id, new Date(), (manifest, folder) =>
            stampSchemaVersion(manifest, folder, 'home/eigen.mail/mail.db', 999),
        );
        const before = await untakenState(user.id);

        await expect(restoreHome(artifact, user.id, `restore-newer-${Date.now()}`)).rejects.toThrow(
            /newer than this server/,
        );

        await expectNotTaken(user.id, before);
        expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toEqual(names);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    test("a document's database from a newer server is refused before the home is taken", async () => {
        const doc = await drivePost(user.sessionToken, user.id, mountId, `folder/${rootId}/create/doc`, {
            fileName: 'Newer Doc',
        });
        // Opened once, so its data.db is on disk for the backup to carry.
        expect((await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/file/${doc.id}`)).status).toBe(
            200,
        );
        const artifact = await backup(user.id, new Date(Date.now() + 30_000), async (manifest, folder) => {
            const entry = manifest.entries.find((e) => e.path.includes('Newer Doc') && e.path.endsWith('/data.db'));
            if (!entry) throw new Error('the archive carries no data.db for Newer Doc');
            await stampSchemaVersion(manifest, folder, entry.path, 999);
        });
        const before = await untakenState(user.id);

        await expect(restoreHome(artifact, user.id, `restore-newer-doc-${Date.now()}`)).rejects.toThrow(
            /at collab schema v999, newer than this server/,
        );

        await expectNotTaken(user.id, before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
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

    test('a deleted user is not re-created by an archive whose shares.json does not read', async () => {
        const ctx = await getTestContext();
        const doomed = await createTestUser('restore-shares-deleted@test.eigen.is', PASSWORD, 'Restore Bad Shares');
        expect((await authedRequest(doomed.sessionToken, `/drive/${doomed.id}/mounts`)).status).toBe(200);
        const artifact = await backup(doomed.id, new Date(), async (manifest, folder) => {
            writeFileSync(join(folder, ARCHIVE_SHARES_FILE), JSON.stringify([{ target: 'no identifier' }]));
            await restateEntry(manifest, folder, ARCHIVE_SHARES_FILE);
        });
        expect(
            (await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${doomed.id}`, { method: 'DELETE' }))
                .status,
        ).toBe(200);

        await expect(restoreHome(artifact, doomed.id, `restore-deleted-shares-${Date.now()}`)).rejects.toThrow(
            /shares\.json is not a set of share-registry rows/,
        );

        // Judged with the archive, before the home goes aside: no row goes in, and no folder is left half written.
        expect(getAuthDrizzleDb().select().from(userScheme).where(eq(userScheme.id, doomed.id)).all()).toEqual([]);
        expect(safetyCopies(doomed.id, FAILED_RESTORE_SUFFIX)).toEqual([]);
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

    test('stores a share target from the archive lowercased', async () => {
        const mixedCase = await backup(deleted.id, new Date(Date.now() + 60_000), async (manifest, folder) => {
            writeFileSync(
                join(folder, ARCHIVE_SHARES_FILE),
                JSON.stringify([{ targetIdentifier: 'Mixed.Case@External.Test' }]),
            );
            await restateEntry(manifest, folder, ARCHIVE_SHARES_FILE);
        });
        await restoreHome(mixedCase, deleted.id, `restore-shares-case-${Date.now()}`);
        rmSync(join(getBackupsDir(), mixedCase), { force: true });
        const rows = (await getEigenDb())
            .select()
            .from(shareRegistry)
            .where(eq(shareRegistry.fromUserId, deleted.id))
            .all();
        expect(rows.map((row) => row.targetIdentifier)).toContain('mixed.case@external.test');
        expect(rows.map((row) => row.targetIdentifier)).not.toContain('Mixed.Case@External.Test');
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

describe('Backup restore when a share row cannot be written', () => {
    test('the restored home stays with its account, and a retry writes the rest', async () => {
        const ctx = await getTestContext();
        const user = await createTestUser('restore-sharefail@test.eigen.is', PASSWORD, 'Restore Share Fail');
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`),
        );
        const rootId = (
            await assertJson<DrivePath>(
                await authedRequest(user.sessionToken, `/drive/${user.id}/${mounts[0].id}/root`),
            )
        ).id;
        const file = await driveUpload(
            user.sessionToken,
            user.id,
            mounts[0].id,
            rootId,
            new File([TEST_PNG_BYTES], 'kept.png', { type: 'image/png' }),
        );
        expect(
            (
                await authedRequest(user.sessionToken, `/drive/${user.id}/${mounts[0].id}/path/${file.id}/acl`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: SHARE_TARGET, read: true, write: false }] }),
                })
            ).status,
        ).toBe(200);
        const artifact = await backup(user.id, new Date());
        expect(
            (await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${user.id}`, { method: 'DELETE' }))
                .status,
        ).toBe(200);
        const authDb = getAuthDrizzleDb();
        const sharesOf = async () =>
            (await getEigenDb())
                .select()
                .from(shareRegistry)
                .where(eq(shareRegistry.fromUserId, user.id))
                .all()
                .map((row) => row.targetIdentifier);

        const spy = spyOn(registryModule, 'addRegistryEntry').mockRejectedValue(new Error('failed by the test'));
        try {
            await expect(restoreHome(artifact, user.id, `restore-sharefail-${Date.now()}`)).rejects.toThrow(
                'failed by the test',
            );
        } finally {
            spy.mockRestore();
        }

        // The account and the home it signs in to are both there. Only the share row is missing.
        expect(authDb.select().from(userScheme).where(eq(userScheme.id, user.id)).all().length).toBe(1);
        expect(existsSync(join(TEST_DATA_DIR, 'home', user.id))).toBe(true);
        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX)).toEqual([]);
        expect(await sharesOf()).toEqual([]);

        await restoreHome(artifact, user.id, `restore-sharefail-retry-${Date.now()}`);

        expect(await sharesOf()).toEqual([SHARE_TARGET]);
        removeSafetyCopies(user.id);
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

    // Every test below restores this one artifact, so it goes once they are all done, whichever of them ran.
    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
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
    });

    // A member's stream is their own home's, which the restore never touched: the team's epoch rides along with it.
    test("a member's stream announces the team's new epoch, and a non-member's never names the team", async () => {
        jest.useFakeTimers();
        const member = await openEventStream(ctx.alice.user.id);
        const outsider = await openEventStream(ctx.bob.user.id);
        try {
            const before = await member.announced();
            const outsiderBefore = await outsider.announced();
            expect(before[ownerId]).toBe(getDataEpoch(ownerId));
            expect(Object.keys(outsiderBefore)).not.toContain(ownerId);

            await restoreHome(artifact, ownerId, `restore-team-sse-${Date.now()}`);
            jest.advanceTimersByTime(15_000);

            const after = await member.announced();
            expect(after[ownerId]).not.toBe(before[ownerId]);
            expect(after[ctx.alice.user.id]).toBe(before[ctx.alice.user.id]);
            expect(await outsider.announced()).toEqual(outsiderBefore);
        } finally {
            jest.useRealTimers();
            await member.close();
            await outsider.close();
        }
    });
});

describe('Backup restore over a live user', () => {
    // A restore puts a home's data back; it never rewrites who somebody is. An id whose email no
    // longer matches the archive is a different person, and their home is not this archive's to
    // replace.
    test('refuses when the email no longer matches the archive, before the home is taken', async () => {
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

        const home = await getHome(user.id);
        const epoch = getDataEpoch(user.id);

        await expect(restoreHome(artifact, user.id, `restore-email-${Date.now()}`)).rejects.toThrow(
            /is now someone-else@test.eigen.is; the archive holds restore-email@test.eigen.is/,
        );

        // Judged with the archive, before the home is taken: it was never evicted, moved aside or told to reload.
        expect(await getHome(user.id)).toBe(home);
        expect(safetyCopies(user.id, PRE_RESTORE_SUFFIX)).toEqual([]);
        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX)).toEqual([]);
        expect(getDataEpoch(user.id)).toBe(epoch);
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

    // An avatar can be far larger than what it compresses to, and a restore runs in the API.
    test('copies the picture without reading it into memory', async () => {
        await getTestContext();
        const user = await createTestUser('restore-avatar-copy@test.eigen.is', PASSWORD, 'Restore Avatar Copy');
        await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`);
        const own = join(getAvatarsDir(), `${user.id}.webp`);
        await Bun.write(own, TEST_PNG_BYTES);
        const artifact = await backup(user.id, new Date());
        rmSync(own, { force: true });

        const copy = spyOn(nodeFsPromises, 'copyFile');
        let copied: string[] = [];
        try {
            await restoreHome(artifact, user.id, `restore-avatar-copy-${Date.now()}`);
            copied = copy.mock.calls.map(([, target]) => String(target));
        } finally {
            copy.mockRestore();
        }
        expect(copied).toEqual([own]);
        expect(new Uint8Array(await Bun.file(own).arrayBuffer())).toEqual(TEST_PNG_BYTES);
        rmSync(own, { force: true });
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });
});

describe('Backup restore of a flat-key mount', () => {
    test("a file named exactly another file's key keeps its own bytes, and so does that file", async () => {
        await getTestContext();
        const user = await createTestUser('restore-key-name@test.eigen.is', PASSWORD, 'Restore Key Name');
        const mountId = await firstMountId(user.sessionToken, user.id);
        const rootId = (
            await assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`))
        ).id;
        const upload = (bytes: string, name: string) =>
            driveUpload<DrivePath>(user.sessionToken, user.id, mountId, rootId, new File([bytes], name));
        const first = await upload('the first file', 'first.txt');
        const home = await getHome(user.id);
        const firstKey = await home.drive
            .getMounts()
            .find((candidate) => candidate.id === mountId)
            ?.findStorageKey(first.id);
        if (!firstKey) throw new Error('the first file has no storage key');
        const second = await upload('the second file', firstKey);
        const content = async (id: string) => {
            const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/file/${id}/download`);
            return res.text();
        };

        const artifact = await backup(user.id, new Date());
        await restoreHome(artifact, user.id, `restore-key-name-${Date.now()}`);

        expect(await content(first.id)).toBe('the first file');
        expect(await content(second.id)).toBe('the second file');
        rmSync(join(getBackupsDir(), artifact), { force: true });
        removeSafetyCopies(user.id);
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

        await home.settings.set({
            mounts: { [DISABLED_MOUNT_ID]: { ...on.mounts![DISABLED_MOUNT_ID], enabled: false } },
        });
        await evictHome(user.id);

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
        await home.settings.set({
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
        await evictHome(user.id);

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
        await home.settings.set({
            mounts: { [PASSIVE_MOUNT_ID]: { ...on.mounts![PASSIVE_MOUNT_ID], enabled: false } },
        });
        await evictHome(user.id);

        const mountDir = join(TEST_DATA_DIR, 'home', user.id, 'mounts', PASSIVE_MOUNT_ID);
        rmSync(join(mountDir, 'tmp'), { recursive: true, force: true });

        const artifact = await backup(user.id, new Date());
        rmSync(join(getBackupsDir(), artifact), { force: true });

        expect(existsSync(join(mountDir, 'tmp'))).toBe(false);
    });
});

describe('Backup restore refuses a member that is not a complete home', () => {
    // A Full member of a whole-server archive leaves out an s3 mount's objects, which only a restore of
    // that whole archive leaves in place. restoreHome refuses one from its manifest before it touches the home.
    const S3_MOUNT_ID = 'restore-partial-s3';
    const S3_BACKING = join(TEST_DATA_DIR, 'restore-partial-backing');
    let user: TestUser;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('restore-partial@test.eigen.is', PASSWORD, 'Restore Partial');
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
            new File([TEST_PNG_BYTES], 'live.png', { type: 'image/png' }),
        );
    });

    // Never evicted, nothing moved aside or parked, no tab told to reload, the home serving what it served.
    async function expectUntouched(home: Home, before: string[], epoch: string): Promise<void> {
        expect(await getHome(user.id)).toBe(home);
        expect(safetyCopies(user.id, PRE_RESTORE_SUFFIX)).toEqual([]);
        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX)).toEqual([]);
        expect(getDataEpoch(user.id)).toBe(epoch);
        expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toEqual(before);
    }

    test('a Full member of a home without s3 mounts is complete and restores', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 60_000), undefined, 'full');
        await restoreHome(artifact, user.id, `restore-full-${Date.now()}`);
        expect(await rootNames(user.sessionToken, user.id, mountId, rootId)).toContain('live.png');
        rmSync(join(getBackupsDir(), artifact), { force: true });
        for (const name of safetyCopies(user.id, PRE_RESTORE_SUFFIX)) {
            rmSync(join(TEST_DATA_DIR, 'home', name), { recursive: true, force: true });
        }
    });

    test('a metadata-only mount is refused by name and the live home is untouched', async () => {
        const home = await getHome(user.id);
        const { mount } = createHomeFaultMount(home, S3_MOUNT_ID, S3_BACKING);
        await mount.init();
        registerFaultMount(home.drive, mount);
        try {
            const s3Root = (await mount.getRootFolder())!.id;
            await seedFile(mount, s3Root, 'remote.png', 'image/png', TEST_PNG_BYTES.byteLength, TEST_PNG_BYTES);
            await mount.uploadQueue?.drain({ flushNow: true });
            const before = await rootNames(user.sessionToken, user.id, mountId, rootId);
            const epoch = getDataEpoch(user.id);
            const artifact = await backup(user.id, new Date(Date.now() + 120_000), undefined, 'full');

            await expect(restoreHome(artifact, user.id, `restore-metadata-${Date.now()}`)).rejects.toThrow(
                `${artifact} holds only the metadata of mount ${S3_MOUNT_ID}`,
            );

            await expectUntouched(home, before, epoch);
            rmSync(join(getBackupsDir(), artifact), { force: true });
        } finally {
            unregisterFaultMount(home.drive, S3_MOUNT_ID);
            await mount.closeAllDatabases().catch(() => {});
            rmSync(S3_BACKING, { recursive: true, force: true });
        }
    });
});

describe('Backup round trip of a home that stores files by name', () => {
    async function backUp(userId: string): Promise<string> {
        const job = await waitForJob(
            startBackupJob('backup', userId, undefined, (started, onProgress) =>
                runHomeBackup(userId, started, onProgress),
            ).id,
        );
        expect(job.error).toBeUndefined();
        return job.artifact!;
    }

    test('the per-home backup verifies and its restore puts every renamed, trashed and versioned item back', async () => {
        const shape = await realShapeHome();
        const { user } = shape;
        await restoreHome(await backUp(user.id), user.id, `restore-real-shape-${Date.now()}`);
        expectRealShape(join(TEST_DATA_DIR, 'home', user.id), shape);
        await expectRealShapeServed(shape);
    });

    // Dovecot dates a message by its file's mtime: a restore that dated every file to itself would put every message
    // of the home at the restore in a client that sorts by received date.
    test('a restore puts a Maildir message back with its mtime, private', async () => {
        const { user } = await realShapeHome();
        await deliverMail(user.email, 'Received long ago');
        const maildir = join(TEST_DATA_DIR, 'home', user.id, MAILDIR_ROOT);
        const received = new Date('2021-03-04T05:06:07Z');
        const [delivered] = [...new Bun.Glob('{cur,new}/*').scanSync({ cwd: maildir })];
        utimesSync(join(maildir, delivered), received, received);
        const unique = basename(delivered).split(':')[0];
        // Dovecot runs as the API's user, so a message and its folder are for that user alone.
        const restored = () => {
            const [message] = [...new Bun.Glob(`{cur,new}/${unique}*`).scanSync({ cwd: maildir })];
            const stat = statSync(join(maildir, message));
            const folderMode = statSync(join(maildir, message, '..')).mode & 0o7777;
            return { mtime: stat.mtime, mode: stat.mode & 0o7777, folderMode };
        };
        const artifact = await backUp(user.id);

        await restoreHome(artifact, user.id, `restore-mtime-${Date.now()}`);
        expect(restored()).toEqual({ mtime: received, mode: 0o600, folderMode: 0o700 });
    });
});

describe('Backup restore of one home judges, then takes the home', () => {
    let user: TestUser;
    let mountId: string;
    let rootId: string;
    let trashedId: string;

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('restore-judged@test.eigen.is', PASSWORD, 'Restore Judged');
        mountId = await firstMountId(user.sessionToken, user.id);
        rootId = (
            await assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`))
        ).id;
        await driveUpload(user.sessionToken, user.id, mountId, rootId, new File(['kept'], 'kept.txt'));
        trashedId = (
            await driveUpload<DrivePath>(user.sessionToken, user.id, mountId, rootId, new File(['old'], 'old.txt'))
        ).id;
        const deleted = await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/path/${trashedId}`, {
            method: 'DELETE',
        });
        expect(deleted.status).toBe(200);
    });

    // Trashed long ago, past any retention, so the purge at the restored home's first load would delete it.
    function trashLongAgo(homeDir: string): void {
        const db = openMountMetadata(join(homeDir, 'mounts', mountId, 'metadata.db'));
        try {
            db.run('UPDATE paths SET trashedAt = 1000 WHERE id = ?', [trashedId]);
        } finally {
            db.close();
        }
    }

    function trashedAtIn(homeDir: string): number | null {
        const db = openMountMetadata(join(homeDir, 'mounts', mountId, 'metadata.db'));
        try {
            return db
                .query<{ trashedAt: number | null }, [string]>('SELECT trashedAt FROM paths WHERE id = ?')
                .get(trashedId)!.trashedAt;
        } finally {
            db.close();
        }
    }

    test('the home serves while the archive is unpacked and verified', async () => {
        const artifact = await backup(user.id, new Date());
        const before = await untakenState(user.id);
        const verify = verifyModule.verifyFolder;
        let served: number | undefined;
        const spy = spyOn(verifyModule, 'verifyFolder').mockImplementation(async (dir, onProgress) => {
            served = (await authedRequest(user.sessionToken, `/drive/${user.id}/mounts`)).status;
            // A verify that fails stops the restore here, so the home is never taken.
            await verify(dir, onProgress);
            throw new ApiError(400, 'refused by the test');
        });
        try {
            await expect(restoreHome(artifact, user.id, `restore-judged-${Date.now()}`)).rejects.toThrow(
                'refused by the test',
            );
        } finally {
            spy.mockRestore();
        }
        expect(served).toBe(200);
        await expectNotTaken(user.id, before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    // Every database of it is checked against this build, so a newer release whose schemas did not move restores.
    test('an archive of a newer Eigen whose databases this server opens restores', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 60_000), (manifest) => {
            manifest.appVersion = '999.0.0';
        });

        await restoreHome(artifact, user.id, `restore-newer-app-${Date.now()}`);

        expect(safetyCopies(user.id, PRE_RESTORE_SUFFIX)).toHaveLength(1);
        rmSync(join(getBackupsDir(), artifact), { force: true });
        removeSafetyCopies(user.id);
    });

    test('a trash that cannot be dated refuses the restore before the home is taken', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 90_000));
        const before = await untakenState(user.id);
        const spy = spyOn(materializeModule, 'redateTrash').mockImplementation(() => {
            throw new Error('failed by the test');
        });
        try {
            await expect(restoreHome(artifact, user.id, `restore-redate-${Date.now()}`)).rejects.toThrow(
                `the trash of ${user.id}'s home cannot be dated: failed by the test`,
            );
        } finally {
            spy.mockRestore();
        }

        await expectNotTaken(user.id, before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    // The archive is unpacked on the data disk beside the home, so the home is offline only for the swap's two renames.
    test('the mounts are put in place beside the home while it serves, and the swap is two renames', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 95_000));
        const homeDir = join(TEST_DATA_DIR, 'home', user.id);
        const jobId = `restore-renames-${Date.now()}`;
        const stagingDir = buildRestoreStagingDir(homeDir, jobId);
        const unpackedHome = join(stagingDir, 'unpack', buildHomeFolderName(user.id), 'home');
        const serving = await getHome(user.id);
        const materialize = materializeModule.materializeMount;
        const staged: { served: boolean; mode: number; homeDir: string }[] = [];
        const materializeSpy = spyOn(materializeModule, 'materializeMount').mockImplementation(
            (dir, summary, stamp) => {
                staged.push({
                    served: loadedHome(user.id) === serving,
                    mode: statSync(stagingDir).mode & 0o777,
                    homeDir: dir,
                });
                return materialize(dir, summary, stamp);
            },
        );
        const rename = nodeFs.renameSync;
        const renames: string[][] = [];
        const renameSpy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            if (from === homeDir || to === homeDir) renames.push([String(from), String(to)]);
            rename(from, to);
        });
        try {
            await restoreHome(artifact, user.id, jobId);
        } finally {
            materializeSpy.mockRestore();
            renameSpy.mockRestore();
        }

        expect(staged).not.toHaveLength(0);
        for (const mount of staged) expect(mount).toEqual({ served: true, mode: 0o700, homeDir: unpackedHome });
        // A folder no home lookup reads as a home, on the disk of the homes it sits beside.
        expect(dirname(stagingDir)).toBe(dirname(homeDir));
        expect(basename(stagingDir)).toStartWith('.');
        const [aside] = safetyCopies(user.id, PRE_RESTORE_SUFFIX);
        expect(renames).toEqual([
            [homeDir, join(dirname(homeDir), aside)],
            [unpackedHome, homeDir],
        ]);
        expect(existsSync(stagingDir)).toBe(false);
        rmSync(join(getBackupsDir(), artifact), { force: true });
        removeSafetyCopies(user.id);
    });

    test('a restore data/ has no room to unpack is refused before anything is unpacked', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 97_000));
        const manifest = await readArtifactManifest(join(getBackupsDir(), artifact));
        const before = await untakenState(user.id);
        let checked: { needed: number; dir: string } | undefined;
        const roomSpy = spyOn(pathsModule, 'roomShortfall').mockImplementation((what, needed, dir, where) => {
            checked = { needed, dir };
            return `${what} has no room by the test; ${where} is full`;
        });
        const jobId = `restore-room-${Date.now()}`;
        const homeDir = join(getDataRoot(), 'home', user.id);
        try {
            await expect(restoreHome(artifact, user.id, jobId)).rejects.toMatchObject({ status: 507 });
        } finally {
            roomSpy.mockRestore();
        }

        // The bytes the manifest counts, a tenth more and a reserve, on the disk the archive unpacks on.
        expect(checked).toEqual({
            needed: archiveModule.withUnpackSlack(manifest.counts.bytes),
            dir: pathsModule.buildRestoreUnpackDir(homeDir, jobId),
        });
        expect(existsSync(pathsModule.buildRestoreStagingDir(homeDir, jobId))).toBe(false);
        await expectNotTaken(user.id, before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    test('putting a mount in place gives the event loop back between batches of files', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 99_000));
        const unpackDir = mkdtempSync(join(TEST_DATA_DIR, 'restore-batches-'));
        await extractArtifact(join(getBackupsDir(), artifact), unpackDir);
        const { folder, manifest } = archiveModule.readUnpackedHome(unpackDir, user.id, artifact);
        const mountDir = join(folder, 'home', 'mounts', mountId);
        const db = openMountMetadata(join(mountDir, 'metadata.db'));
        const count = 1200;
        try {
            db.run(`CREATE TEMP TABLE copied AS SELECT * FROM paths WHERE name = 'kept.txt'`);
            db.transaction(() => {
                for (let index = 0; index < count; index++) {
                    db.run('UPDATE copied SET id = ?, name = ?, file = ?', [
                        `batch-${index}`,
                        `batch-${index}.txt`,
                        `batch-${index}`,
                    ]);
                    db.run('INSERT INTO paths SELECT * FROM copied');
                    writeFileSync(join(mountDir, PATHS.DRIVE.DATA_DIR, `batch-${index}.txt`), String(index));
                }
            })();
        } finally {
            db.close();
        }
        const turns = countLoopTurns();
        const turnsAtMove: number[] = [];
        const rename = nodeFs.renameSync;
        const spy = spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
            if (basename(String(from)).startsWith('batch-')) turnsAtMove.push(turns.read());
            rename(from, to);
        });
        try {
            const summary = manifest.mounts.find((mount) => mount.id === mountId);
            if (!summary) throw new Error(`${mountId} is not in the manifest`);
            await materializeModule.materializeMount(join(folder, 'home'), summary, 'batches');
        } finally {
            spy.mockRestore();
            turns.stop();
        }

        expect(turnsAtMove).toHaveLength(count);
        // Each file lands at the key a local-key mount reads it from, its id.
        expect(existsSync(join(mountDir, PATHS.DRIVE.DATA_DIR, `batch-${count - 1}`))).toBe(true);
        // The loop turned between the first file and the last.
        expect(turnsAtMove.at(-1)).toBeGreaterThan(turnsAtMove[0]);
        rmSync(unpackDir, { recursive: true, force: true });
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    test('a safety copy from a newer server is refused while the home still serves', async () => {
        const artifact = await backup(user.id, new Date(Date.now() + 100_000));
        await restoreHome(artifact, user.id, `restore-copy-newer-${Date.now()}`);
        const [copy] = safetyCopies(user.id, PRE_RESTORE_SUFFIX);
        const db = openMountMetadata(join(TEST_DATA_DIR, 'home', copy, 'mounts', mountId, 'metadata.db'));
        try {
            db.run('UPDATE __schema_version SET version = 999 WHERE id = 1');
        } finally {
            db.close();
        }
        const before = await untakenState(user.id);

        await expect(restoreSafetyCopy(user.id, copy, `restore-copy-newer-${Date.now()}`)).rejects.toThrow(
            /metadata schema v999, newer than this server/,
        );

        await expectNotTaken(user.id, before);
        rmSync(join(getBackupsDir(), artifact), { force: true });
        removeSafetyCopies(user.id);
    });

    test('a restore, and a restore of the copy it left, start the trash over', async () => {
        const homeDir = join(TEST_DATA_DIR, 'home', user.id);
        trashLongAgo(homeDir);
        const artifact = await backup(user.id, new Date(Date.now() + 120_000));
        const restoredAt = Math.floor(Date.now() / 1000);
        await restoreHome(artifact, user.id, `restore-trash-${Date.now()}`);
        expect(trashedAtIn(homeDir)).toBeGreaterThanOrEqual(restoredAt);

        const [copy] = safetyCopies(user.id, PRE_RESTORE_SUFFIX);
        expect(trashedAtIn(join(TEST_DATA_DIR, 'home', copy))).toBe(1000);
        const putBackAt = Math.floor(Date.now() / 1000);
        await restoreSafetyCopy(user.id, copy, `restore-trash-copy-${Date.now()}`);
        expect(trashedAtIn(homeDir)).toBeGreaterThanOrEqual(putBackAt);

        rmSync(join(getBackupsDir(), artifact), { force: true });
        removeSafetyCopies(user.id);
    });
});

// A process killed anywhere in a restore leaves the folder its job staged beside the home, with the notes in it, and
// the next boot finishes or undoes the restore from them. The notes sit on the home's own disk, so a boot that runs
// without the backups folder reads them as well as one with it.
describe('Backup restore killed at any point', () => {
    const KILLED = new Error('killed by the test');
    let user: TestUser;
    let mountId: string;
    let rootId: string;
    let artifact: string;
    let homeDir: string;

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('restore-killed@test.eigen.is', PASSWORD, 'Restore Killed');
        homeDir = join(TEST_DATA_DIR, 'home', user.id);
        mountId = await firstMountId(user.sessionToken, user.id);
        rootId = (
            await assertJson<DrivePath>(await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/root`))
        ).id;
        await driveUpload(user.sessionToken, user.id, mountId, rootId, new File(['backed up'], 'backed-up.txt'));
        artifact = await backup(user.id, new Date());
        // Only the home as it stands holds this, so it tells that home from the archive's.
        await driveUpload(user.sessionToken, user.id, mountId, rootId, new File(['live'], 'live.txt'));
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    type KillPoint =
        | 'in the unpack'
        | 'while the mounts are put in place'
        | 'between the marker and the move-aside'
        | 'between the two renames'
        | 'before the marker goes';

    // A restore that dies at `point`: from there on nothing the job would still do happens, its rollback and its
    // cleanup included, so the disk is left as a kill leaves it.
    async function restoreKilledAt(point: KillPoint): Promise<void> {
        let killed = false;
        const kill = (): never => {
            killed = true;
            throw KILLED;
        };
        const extract = archiveModule.extractArtifact;
        const materialize = materializeModule.materializeMount;
        const dropMarker = recoveryModule.dropRestoringMarker;
        const rename = nodeFs.renameSync;
        const spies = [
            spyOn(recoveryModule, 'wipeRestoreStagingDir').mockImplementation(async () => {}),
            spyOn(archiveModule, 'extractArtifact').mockImplementation(async (source, target) => {
                await extract(source, target);
                if (point === 'in the unpack') kill();
            }),
            spyOn(materializeModule, 'materializeMount').mockImplementation(async (dir, summary, stamp) => {
                const placed = await materialize(dir, summary, stamp);
                return point === 'while the mounts are put in place' ? kill() : placed;
            }),
            spyOn(nodeFs, 'renameSync').mockImplementation((from, to) => {
                if (killed) throw KILLED;
                if (point === 'between the marker and the move-aside' && from === homeDir) kill();
                if (point === 'between the two renames' && to === homeDir) kill();
                rename(from, to);
            }),
            spyOn(recoveryModule, 'dropRestoringMarker').mockImplementation((dir) => {
                if (point === 'before the marker goes') kill();
                dropMarker(dir);
            }),
        ];
        try {
            const failed = await restoreHome(artifact, user.id, `restore-killed-${Date.now()}`).catch(
                (error: unknown) => error,
            );
            // A kill that lands in the rollback reaches the caller as the cause of the error that says the account is
            // shut.
            expect(failed instanceof Error && failed.cause === KILLED ? failed.cause : failed).toBe(KILLED);
        } finally {
            for (const spy of spies) spy.mockRestore();
            // The marks are the process's own, so the one a kill leaves set is gone at the restart.
            clearHomeRestoring(user.id);
        }
    }

    async function rootNames(): Promise<string[]> {
        const items = await driveGetList(user.sessionToken, user.id, mountId, `folder/${rootId}`);
        return items.map((item) => item.name).sort();
    }

    // What every kill comes back to: the home as it was serves, and nothing staged is left.
    async function expectHomeAsItWas(): Promise<void> {
        expect(await rootNames()).toContain('live.txt');
        expect(safetyCopies(user.id, PRE_RESTORE_SUFFIX)).toEqual([]);
        expect(restoreStagingFolders()).toEqual([]);
    }

    for (const point of [
        'in the unpack',
        'while the mounts are put in place',
        'between the marker and the move-aside',
        'between the two renames',
    ] as const) {
        test(`a restore killed ${point} leaves the home as it was after the next boot`, async () => {
            await restoreKilledAt(point);
            expect(restoreStagingFolders()).toHaveLength(1);

            await recoverBackupsAfterRestart();

            await expectHomeAsItWas();
            expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX)).toEqual([]);
        });
    }

    // A boot without the backups folder, such as one with its mount missing, still finds the notes, so the restored
    // home goes aside at once. A later boot with the folder back has nothing left to act on, and the work done on the
    // home in between stays.
    test('a restore killed before its marker goes is undone by the next boot, and a later boot changes nothing', async () => {
        await restoreKilledAt('before the marker goes');
        // Both renames ran: the restored home is in place and the home as it was is aside.
        expect(existsSync(homeDir)).toBe(true);
        expect(safetyCopies(user.id, PRE_RESTORE_SUFFIX)).toHaveLength(1);

        const backupsDir = process.env['EIGEN_BACKUPS_DIR'];
        process.env['EIGEN_BACKUPS_DIR'] = join(TEST_DATA_DIR, 'restore-killed-no-backups');
        try {
            await recoverBackupsAfterRestart();
        } finally {
            if (backupsDir === undefined) delete process.env['EIGEN_BACKUPS_DIR'];
            else process.env['EIGEN_BACKUPS_DIR'] = backupsDir;
        }
        await expectHomeAsItWas();
        const [parked] = safetyCopies(user.id, FAILED_RESTORE_SUFFIX);
        expect(parked).toBeDefined();
        await driveUpload(user.sessionToken, user.id, mountId, rootId, new File(['a day'], 'a-day-of-work.txt'));

        await recoverBackupsAfterRestart();

        expect(await rootNames()).toContain('a-day-of-work.txt');
        expect(safetyCopies(user.id, FAILED_RESTORE_SUFFIX)).toEqual([parked]);
        removeSafetyCopies(user.id);
    });
});
