import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_HOME_REPLACED_CLOSE } from '@workspace/lib/constants/collab';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { user as userScheme } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import { getEigenDb } from '../../lib/share/db';
import { shareRegistry } from '../../lib/share/schema';
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
// `patch` doctors the manifest before packing, which is how a restore is made to fail late.
async function backup(userId: string, at: Date, patch?: (manifest: BackupManifest) => void): Promise<string> {
    const home = await getHome(userId);
    const staging = mkdtempSync(join(TEST_DATA_DIR, 'restore-backup-'));
    const folder = join(staging, buildHomeFolderName(userId));
    const manifest = await snapshotHome(home, staging);
    if (patch) {
        patch(manifest);
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

function safetyCopies(userId: string, suffix: string): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter((name) => name.startsWith(`${userId}${suffix}`));
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

        const [preRestore] = safetyCopies(target.id, '.pre-restore-');
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
        expect(safetyCopies(ctx.bob.user.id, '.pre-restore-')).toEqual([]);
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

        expect(safetyCopies(target.id, '.failed-restore-').length).toBe(1);
        expect(existsSync(join(TEST_DATA_DIR, 'home', target.id))).toBe(true);
        // The mark is cleared, so the home serves again — from the folder that was put back.
        expect(await rootNames(target.sessionToken, target.id, mountId, rootId)).toEqual(before);
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
