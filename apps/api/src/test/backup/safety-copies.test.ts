import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { auth } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import {
    buildArtifactName,
    buildHomeFolderName,
    FAILED_RESTORE_SUFFIX,
    getBackupsDir,
    PRE_RESTORE_SUFFIX,
} from '../../lib/backup/paths';
import { restoreHome, restoreSafetyCopy } from '../../lib/backup/restore';
import { deleteSafetyCopy, listSafetyCopies } from '../../lib/backup/safety-copy';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getHome } from '../../lib/home/get-home';
import * as mountHelpers from '../../lib/mount/helpers';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import {
    createHomeFaultMount,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    driveUpload,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

const MOUNT_ID = 'safety-s3';
const PASSWORD = 'testpassword123';
// The fake bucket, outside the home so a restore of the home folder never touches it.
const BACKING = join(TEST_DATA_DIR, 'safety-s3-backing');
// What the bucket holds for the PNG's key after the backup: an edit a restore must not overwrite.
const EDITED_BYTES = new TextEncoder().encode('edited in the bucket after the backup ran');
// Smaller than any real home folder, so a listing of this size can only be a fresh measurement.
const MARKER_BYTES = 512;

function fileKeysOf(metadataPath: string): string[] {
    const db = openMountMetadata(metadataPath);
    try {
        // A remote mount stores flat keys, so the key of a file row is its own `file` value.
        return db
            .query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'")
            .all()
            .map((row) => row.file)
            .sort();
    } finally {
        db.close();
    }
}

function keyOf(metadataPath: string, pathId: string): string {
    const db = openMountMetadata(metadataPath);
    try {
        return db.query<{ file: string }, [string]>('SELECT file FROM paths WHERE id = ?').get(pathId)!.file;
    } finally {
        db.close();
    }
}

async function bytesInBucket(mount: Mount, storageKey: string): Promise<Uint8Array | null> {
    // storage.read goes straight to the backing store — never the staged copy mount.readKey prefers.
    const file = mount.storage.read(storageKey);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
}

function safetyCopies(userId: string, suffix = PRE_RESTORE_SUFFIX): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter((name) => name.startsWith(`${userId}${suffix}`));
}

describe('Backup safety copies of an s3 home', () => {
    let userId: string;
    let token: string;
    let homeDir: string;
    let mount: Mount;
    let artifact: string;
    let metadataPath: string;
    let pngId: string;
    let pngKey: string;
    let versionId: string;
    let versionKey: string;
    let ghostId: string;
    let ghostKey: string;
    let dataDbKey: string;
    let keysBefore: string[];
    let keysAfter: string[];
    // The restored keys with an object behind them: the byte-less row was rekeyed but nothing was
    // staged for it, so no delete can take an object of its.
    let objectKeysAfter: string[];

    beforeAll(async () => {
        await getTestContext();
        const email = 'safety-s3@test.eigen.is';
        const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Safety S3' } });
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
        const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
        if (!match) throw new Error('no session cookie');
        userId = signUp.user.id;
        token = match[1];

        mkdirSync(BACKING, { recursive: true });
        const home = await getHome(userId);
        homeDir = home.homeDir;
        ({ mount } = createHomeFaultMount(home, MOUNT_ID, BACKING));
        await mount.init();
        registerFaultMount(home.drive, mount);
        metadataPath = join(homeDir, 'mounts', MOUNT_ID, 'metadata.db');

        const root = await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/root`));
        const png = await driveUpload<DrivePath>(
            token,
            userId,
            MOUNT_ID,
            root.id,
            new File([TEST_PNG_BYTES], 'bucket.png', { type: 'image/png' }),
        );
        pngId = png.id;
        const doc = await assertJson<DrivePath>(
            await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/folder/${root.id}/create/doc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: 'Bucket Doc' }),
            }),
        );
        const savedVersion = await assertJson<DrivePath>(
            await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/file/${doc.id}/versions/save`, { method: 'POST' }),
        );
        versionId = savedVersion.id;
        // A row with no object behind it: a touched file whose upload never landed. The archive
        // carries no bytes for it, and a restore still has to take its key away from it.
        ghostId = await mount.touchFile(root.id, 'ghost.txt', 'text/plain');
        await settleContainer(mount, doc.id);
        await mount.drainPendingUploads({ flushNow: true });

        pngKey = await mount.getStorageKey(pngId);
        versionKey = await mount.getStorageKey(versionId);
        ghostKey = await mount.getStorageKey(ghostId);
        dataDbKey = await mount.getStorageKey((await mount.getChildByName(doc.id, 'data.db'))!.id);
        keysBefore = fileKeysOf(metadataPath);

        const staging = mkdtempSync(join(TEST_DATA_DIR, 'safety-s3-backup-'));
        await snapshotHome(home, staging);
        artifact = buildArtifactName(userId, new Date());
        await packFolder(join(staging, buildHomeFolderName(userId)), join(getBackupsDir(), artifact));
        rmSync(staging, { recursive: true, force: true });

        // The state a restore must not destroy: the object under the PNG's key holds bytes written
        // AFTER the backup, exactly as an edit through the mount would have left them.
        await mount.storage.write(pngKey, EDITED_BYTES);

        unregisterFaultMount(home.drive, MOUNT_ID);
        await mount.closeAllDatabases();
        await restoreHome(artifact, userId, `safety-s3-${Date.now()}`);
        keysAfter = fileKeysOf(metadataPath);
        const ghostFresh = keyOf(metadataPath, ghostId);
        objectKeysAfter = keysAfter.filter((key) => key !== ghostFresh);
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
        rmSync(BACKING, { recursive: true, force: true });
    });

    test('a restore rekeys every row and leaves the objects the safety copy points at alone', async () => {
        expect(keysAfter.length).toBeGreaterThan(0);
        expect(keysAfter.length).toBe(keysBefore.length);
        expect(keysAfter.filter((key) => keysBefore.includes(key))).toEqual([]);
        // The row id still leads the key, so an object is traceable to its file without the table.
        expect(keyOf(metadataPath, pngId).startsWith(`${pngId}-r`)).toBe(true);
        // A version snapshot is a file row like any other, and so is a container's data.db.
        expect(keyOf(metadataPath, versionId)).not.toBe(versionKey);
        // The row the archive carries no bytes for is rekeyed too: keeping its old key would leave
        // the live home and the safety copy naming one object, for a late upload to land on.
        expect(keyOf(metadataPath, ghostId)).not.toBe(ghostKey);

        expect(await bytesInBucket(mount, pngKey)).toEqual(EDITED_BYTES);
        expect(await bytesInBucket(mount, dataDbKey)).not.toBeNull();
    });

    test('the archive bytes drain to the fresh keys, beside the untouched old ones', async () => {
        const home = await getHome(userId);
        const { mount: restored } = createHomeFaultMount(home, MOUNT_ID, BACKING);
        await restored.init();
        try {
            await restored.drainPendingUploads({ flushNow: true });
            const freshKey = await restored.getStorageKey(pngId);
            expect(freshKey).not.toBe(pngKey);
            expect(await bytesInBucket(restored, freshKey)).toEqual(TEST_PNG_BYTES);
            expect(await bytesInBucket(restored, pngKey)).toEqual(EDITED_BYTES);
            // Nothing was staged for the byte-less row, so its fresh key names no object at all.
            expect(await bytesInBucket(restored, await restored.getStorageKey(ghostId))).toBeNull();
        } finally {
            await restored.closeAllDatabases();
        }
    });

    test('restoring the safety copy serves the bytes the bucket held before the restore', async () => {
        const [copy] = safetyCopies(userId);
        expect(copy).toBeTruthy();
        // Measured (and memoized) while the folder is still a safety copy, so the assertion at the
        // end of this test says something about the memo and not about the walk.
        const measured = (await listSafetyCopies(userId)).find((entry) => entry.name === copy);
        expect(measured?.bytes).toBeGreaterThan(MARKER_BYTES);

        await restoreSafetyCopy(userId, copy, `safety-s3-undo-${Date.now()}`);

        expect(fileKeysOf(metadataPath)).toEqual(keysBefore);
        const home = await getHome(userId);
        const { mount: back } = createHomeFaultMount(home, MOUNT_ID, BACKING);
        await back.init();
        try {
            const file = await back.readFile(pngId);
            expect(file).not.toBeNull();
            expect(new Uint8Array(await file!.arrayBuffer())).toEqual(EDITED_BYTES);
        } finally {
            await back.closeAllDatabases();
        }

        // The home as the first restore left it is a safety copy of its own now, fresh keys and all.
        const [replaced] = safetyCopies(userId);
        expect(replaced).toBeTruthy();
        expect(fileKeysOf(join(TEST_DATA_DIR, 'home', replaced, 'mounts', MOUNT_ID, 'metadata.db'))).toEqual(keysAfter);

        // The measurement was renamed away with the folder. A later copy can land on that name (one
        // stamp per second), and it would otherwise be listed with the size of this one.
        const revived = join(TEST_DATA_DIR, 'home', copy);
        mkdirSync(revived, { recursive: true });
        writeFileSync(join(revived, 'marker.bin'), Buffer.alloc(MARKER_BYTES));
        const relisted = (await listSafetyCopies(userId)).find((entry) => entry.name === copy);
        expect(relisted?.bytes).toBe(MARKER_BYTES);
        rmSync(revived, { recursive: true, force: true });
    });

    test('a delete that cannot reach the bucket keeps the folder and says so', async () => {
        const [copy] = safetyCopies(userId);
        const copyDir = join(TEST_DATA_DIR, 'home', copy);
        // createHomeFaultMount registers its mount with Drive directly, so the home's settings.json
        // carries no entry for it — write the one a real s3 mount would have.
        writeFileSync(
            join(copyDir, 'settings.json'),
            JSON.stringify({
                mounts: { [MOUNT_ID]: { storageType: 's3', enabled: true, s3Config: mount.config.s3Config } },
            }),
        );
        const inner = new LocalStorage(join(BACKING, MOUNT_ID));
        // An outage, a 403, a rotated key: both backends answer a failed delete with `false`.
        const spy = spyOn(mountHelpers, 'createMountStorage').mockReturnValue({
            read: (key: string) => inner.read(key),
            write: (key: string, data: Parameters<LocalStorage['write']>[1]) => inner.write(key, data),
            exists: (key: string) => inner.exists(key),
            size: (key: string) => inner.size(key),
            delete: async () => false,
        });
        try {
            await expect(deleteSafetyCopy(copyDir, homeDir)).rejects.toThrow('the safety copy was kept');
            expect(existsSync(copyDir)).toBe(true);
            for (const key of objectKeysAfter) expect(await bytesInBucket(mount, key)).not.toBeNull();
        } finally {
            spy.mockRestore();
        }
    });

    test('deleting a safety copy takes only the objects nothing else points at', async () => {
        const [copy] = safetyCopies(userId);
        const copyDir = join(TEST_DATA_DIR, 'home', copy);
        const spy = spyOn(mountHelpers, 'createMountStorage').mockReturnValue(
            new LocalStorage(join(BACKING, MOUNT_ID)),
        );
        try {
            // A second copy of the same state: both name the same objects, so neither delete may take
            // them. Deleting the duplicate leaves every one of them where it is.
            const sibling = join(TEST_DATA_DIR, 'home', `${userId}${PRE_RESTORE_SUFFIX}20200101-000000`);
            cpSync(copyDir, sibling, { recursive: true });
            await deleteSafetyCopy(sibling, homeDir);
            expect(existsSync(sibling)).toBe(false);
            for (const key of objectKeysAfter) expect(await bytesInBucket(mount, key)).not.toBeNull();

            // With no live home to compare against, nothing in the bucket is provably unreferenced.
            const orphaned = join(TEST_DATA_DIR, 'home', `${userId}${PRE_RESTORE_SUFFIX}20200202-000000`);
            cpSync(copyDir, orphaned, { recursive: true });
            const homeAway = `${homeDir}.away`;
            renameSync(homeDir, homeAway);
            await deleteSafetyCopy(orphaned, homeDir);
            renameSync(homeAway, homeDir);
            expect(existsSync(orphaned)).toBe(false);
            for (const key of objectKeysAfter) expect(await bytesInBucket(mount, key)).not.toBeNull();

            // Now the last folder that stood for that state goes, and its objects with it.
            await deleteSafetyCopy(copyDir, homeDir);
            expect(existsSync(copyDir)).toBe(false);
            for (const key of keysAfter) expect(await bytesInBucket(mount, key)).toBeNull();
            // Everything the live home points at survives every one of those deletes.
            for (const key of keysBefore) {
                if (key === ghostKey) continue; // never had an object of its own
                expect(await bytesInBucket(mount, key)).not.toBeNull();
            }
        } finally {
            spy.mockRestore();
        }
    });
});

describe('Backup restore of a safety copy that does not survive its checks', () => {
    let userId: string;
    let token: string;
    let homeDir: string;
    let mountId: string;
    let rootId: string;
    let artifact: string;

    beforeAll(async () => {
        await getTestContext();
        const email = 'safety-rollback@test.eigen.is';
        const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Safety Rollback' } });
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
        const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
        if (!match) throw new Error('no session cookie');
        userId = signUp.user.id;
        token = match[1];
        homeDir = (await getHome(userId)).homeDir;

        const mounts = await assertJson<{ id: string }[]>(await authedRequest(token, `/drive/${userId}/mounts`));
        mountId = mounts[0].id;
        rootId = (await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${mountId}/root`))).id;
        await driveUpload(
            token,
            userId,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'before.png', { type: 'image/png' }),
        );

        const staging = mkdtempSync(join(TEST_DATA_DIR, 'safety-rollback-backup-'));
        await snapshotHome(await getHome(userId), staging);
        artifact = buildArtifactName(userId, new Date());
        await packFolder(join(staging, buildHomeFolderName(userId)), join(getBackupsDir(), artifact));
        rmSync(staging, { recursive: true, force: true });

        await driveUpload(
            token,
            userId,
            mountId,
            rootId,
            new File([TEST_PNG_BYTES], 'after.png', { type: 'image/png' }),
        );
        await restoreHome(artifact, userId, `safety-rollback-${Date.now()}`);
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
    });

    test('a failed restore puts the copy back under the name it came from', async () => {
        const [copy] = safetyCopies(userId);
        expect(copy).toBeTruthy();
        const copyDir = join(TEST_DATA_DIR, 'home', copy);
        // A database the in-place check cannot open: the install throws after both folders have
        // moved, which is the one moment the rollback has to get right.
        writeFileSync(join(copyDir, 'eigen.calendar', 'calendar.db'), 'not a database at all');

        await expect(restoreSafetyCopy(userId, copy, `safety-rollback-fail-${Date.now()}`)).rejects.toThrow();

        // The copy keeps its own name — a `.failed-restore-` one would leave a pristine home the
        // admin can only delete — and the home serves again from the folder it was in.
        expect(existsSync(copyDir)).toBe(true);
        expect(safetyCopies(userId)).toEqual([copy]);
        expect(safetyCopies(userId, FAILED_RESTORE_SUFFIX)).toEqual([]);
        expect(existsSync(homeDir)).toBe(true);
        const listed = await assertJson<DrivePath[]>(
            await authedRequest(token, `/drive/${userId}/${mountId}/folder/${rootId}`),
        );
        expect(listed.map((item) => item.name)).toContain('before.png');
    });

    test('a copy of a home whose owner is gone cannot be restored', async () => {
        const ctx = await getTestContext();
        const [copy] = safetyCopies(userId);
        const del = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${userId}`, { method: 'DELETE' });
        expect(del.status).toBe(200);
        expect(existsSync(homeDir)).toBe(false);

        await expect(restoreSafetyCopy(userId, copy, `safety-rollback-gone-${Date.now()}`)).rejects.toThrow(
            'no longer exists',
        );
        expect(existsSync(join(TEST_DATA_DIR, 'home', copy))).toBe(true);
    });
});
