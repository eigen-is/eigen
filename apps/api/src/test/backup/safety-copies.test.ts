import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { auth } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import { deleteSafetyCopy } from '../../lib/backup/artifacts';
import { buildArtifactName, buildHomeFolderName, getBackupsDir, PRE_RESTORE_SUFFIX } from '../../lib/backup/paths';
import { restoreHome, restoreSafetyCopy } from '../../lib/backup/restore';
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
import { assertJson, authedRequest, driveUpload, getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

const MOUNT_ID = 'safety-s3';
const PASSWORD = 'testpassword123';
// The fake bucket, outside the home so a restore of the home folder never touches it.
const BACKING = join(TEST_DATA_DIR, 'safety-s3-backing');
// What the bucket holds for the PNG's key after the backup: an edit a restore must not overwrite.
const EDITED_BYTES = new TextEncoder().encode('edited in the bucket after the backup ran');

// Read-write on purpose: a WAL database whose owner is not holding it open has no -shm beside it,
// and a read-only open of one fails outright (SQLITE_CANTOPEN) — the shape of every folder here.
function fileKeysOf(metadataPath: string): string[] {
    const db = new Database(metadataPath, { readwrite: true, create: false });
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

async function bytesInBucket(mount: Mount, storageKey: string): Promise<Uint8Array | null> {
    // storage.read goes straight to the backing store — never the staged copy mount.readKey prefers.
    const file = mount.storage.read(storageKey);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
}

function safetyCopies(userId: string): string[] {
    return readdirSync(join(TEST_DATA_DIR, 'home')).filter((name) => name.startsWith(`${userId}${PRE_RESTORE_SUFFIX}`));
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
    let dataDbKey: string;
    let keysBefore: string[];
    let keysAfter: string[];

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
        await settleContainer(mount, doc.id);
        await mount.drainPendingUploads({ flushNow: true });

        pngKey = await mount.getStorageKey(pngId);
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
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
        rmSync(BACKING, { recursive: true, force: true });
    });

    test('a restore rekeys every row and leaves the objects the safety copy points at alone', async () => {
        expect(keysAfter.length).toBe(keysBefore.length);
        expect(keysAfter.filter((key) => keysBefore.includes(key))).toEqual([]);
        // The row id still leads the key, so an object is traceable to its file without the table.
        expect(keysAfter.some((key) => key.startsWith(`${pngId}-r`))).toBe(true);

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
        } finally {
            await restored.closeAllDatabases();
        }
    });

    test('restoring the safety copy serves the bytes the bucket held before the restore', async () => {
        const [copy] = safetyCopies(userId);
        expect(copy).toBeTruthy();

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
    });

    test('deleting a safety copy takes only the objects the live home no longer points at', async () => {
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
        // The fake bucket is a plain directory; the delete pass builds its backend from the config
        // above, which would be a real S3 client.
        const spy = spyOn(mountHelpers, 'createMountStorage').mockReturnValue(
            new LocalStorage(join(BACKING, MOUNT_ID)),
        );
        try {
            const gone = join(TEST_DATA_DIR, 'home', `${userId}${PRE_RESTORE_SUFFIX}20200101-000000`);
            cpSync(copyDir, gone, { recursive: true });
            const homeAway = `${homeDir}.away`;
            renameSync(homeDir, homeAway);
            await deleteSafetyCopy(gone, homeDir);
            renameSync(homeAway, homeDir);
            // With no live home to compare against, nothing in the bucket is provably unreferenced.
            expect(existsSync(gone)).toBe(false);
            for (const key of keysAfter) expect(await bytesInBucket(mount, key)).not.toBeNull();

            await deleteSafetyCopy(copyDir, homeDir);
            expect(existsSync(copyDir)).toBe(false);
            for (const key of keysAfter) expect(await bytesInBucket(mount, key)).toBeNull();
            expect(await bytesInBucket(mount, pngKey)).toEqual(EDITED_BYTES);
        } finally {
            spy.mockRestore();
        }
    });
});
