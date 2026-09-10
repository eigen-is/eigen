import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { packFolder } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import { saveThumbnail } from '../../lib/shared/thumbnails';
import {
    createHomeFaultMount,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    createTestUser,
    driveUpload,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

const MOUNT_ID = 'restore-s3';
// The fake bucket, outside the home so a restore of the home folder never touches it.
const BACKING = join(TEST_DATA_DIR, 'restore-s3-backing');
const TEXT_BYTES = new TextEncoder().encode('a restored plain file, not a database');

type PendingRow = { storageKey: string; stagingPath: string; isDatabase: number };

function pendingUploadsOf(metadataPath: string): PendingRow[] {
    const db = openMountMetadata(metadataPath);
    try {
        return db.query<PendingRow, []>('SELECT storageKey, stagingPath, isDatabase FROM pending_uploads').all();
    } finally {
        db.close();
    }
}

// The key a restored row landed on. A restore onto a remote mount rekeys every row it carries
// (lib/backup/restore.ts), so the keys this file checks only exist once the restore has run.
function keyOf(metadataPath: string, pathId: string): string {
    const db = openMountMetadata(metadataPath);
    try {
        return db.query<{ file: string }, [string]>('SELECT file FROM paths WHERE id = ?').get(pathId)!.file;
    } finally {
        db.close();
    }
}

function fileKeysOf(metadataPath: string): string[] {
    const db = openMountMetadata(metadataPath);
    try {
        // An s3 mount stores flat keys, so the key of a file row is its own `file` value.
        return db
            .query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'")
            .all()
            .map((row) => row.file);
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

describe('Backup restore of an s3 mount', () => {
    let userId: string;
    let token: string;
    let mount: Mount;
    let artifact: string;
    let metadataPath: string;
    let pngKey: string;
    let textKey: string;
    let dataDbKey: string;
    let trashedKey: string;
    let versionKey: string;
    let dataDbId: string;
    let thumbPath: string;

    beforeAll(async () => {
        await getTestContext();
        ({ id: userId, sessionToken: token } = await createTestUser(
            'restore-s3@test.eigen.is',
            'testpassword123',
            'Restore S3',
        ));

        mkdirSync(BACKING, { recursive: true });
        const home = await getHome(userId);
        ({ mount } = createHomeFaultMount(home, MOUNT_ID, BACKING));
        await mount.init();
        registerFaultMount(home.drive, mount);
        metadataPath = join(home.homeDir, 'mounts', MOUNT_ID, 'metadata.db');

        const root = await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/root`));
        const png = await driveUpload<DrivePath>(
            token,
            userId,
            MOUNT_ID,
            root.id,
            new File([TEST_PNG_BYTES], 'bucket.png', { type: 'image/png' }),
        );
        const text = await driveUpload<DrivePath>(
            token,
            userId,
            MOUNT_ID,
            root.id,
            new File([TEXT_BYTES], 'notes.txt', { type: 'text/plain' }),
        );
        const doc = await assertJson<DrivePath>(
            await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/folder/${root.id}/create/doc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: 'Bucket Doc' }),
            }),
        );
        // A trashed file and a version snapshot: on this backend both are flat keys like any other
        // file, and both are archived under a path shape of their own (`.trash/…`, `…/versions/…`).
        const binned = await driveUpload<DrivePath>(
            token,
            userId,
            MOUNT_ID,
            root.id,
            new File([TEXT_BYTES], 'binned.txt', { type: 'text/plain' }),
        );
        expect(
            (await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/path/${binned.id}`, { method: 'DELETE' })).status,
        ).toBe(200);
        const savedVersion = await assertJson<DrivePath>(
            await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/file/${doc.id}/versions/save`, {
                method: 'POST',
            }),
        );

        // Thumbnails live beside the mount's data, not in the bucket, and nothing regenerates one.
        thumbPath = join(mount.thumbsDir, `${png.id}.webp`);
        expect(
            (await saveThumbnail(mount.thumbsDir, png.id, Buffer.from(TEST_PNG_BYTES), 'image/png', 'bucket.png'))
                ?.fileName,
        ).toBe(`${png.id}.webp`);

        await settleContainer(mount, doc.id);
        await mount.drainPendingUploads({ flushNow: true });

        dataDbId = (await mount.getChildByName(doc.id, 'data.db'))!.id;
        expect(await bytesInBucket(mount, await mount.getStorageKey(png.id))).not.toBeNull();

        const staging = mkdtempSync(join(TEST_DATA_DIR, 'restore-s3-backup-'));
        const manifest = await snapshotHome(home, staging);
        expect(manifest.mounts.find((m) => m.id === MOUNT_ID)?.storageType).toBe('s3');
        artifact = buildArtifactName(userId, new Date());
        await packFolder(join(staging, buildHomeFolderName(userId)), join(getBackupsDir(), artifact));
        rmSync(staging, { recursive: true, force: true });

        // Restore onto an empty bucket, the shape of a restore onto a fresh server: every object has
        // to be re-uploaded from the archive, nothing may pass because it happened to still be there.
        unregisterFaultMount(home.drive, MOUNT_ID);
        await mount.closeAllDatabases();
        rmSync(join(BACKING, MOUNT_ID), { recursive: true, force: true });
        // Gone with the bucket, so only the archive can put it back.
        rmSync(thumbPath, { force: true });

        await restoreHome(artifact, userId, `restore-s3-${Date.now()}`);

        trashedKey = keyOf(metadataPath, binned.id);
        versionKey = keyOf(metadataPath, savedVersion.id);
        pngKey = keyOf(metadataPath, png.id);
        textKey = keyOf(metadataPath, text.id);
        dataDbKey = keyOf(metadataPath, dataDbId);
    });

    afterAll(() => {
        rmSync(join(getBackupsDir(), artifact), { force: true });
        rmSync(BACKING, { recursive: true, force: true });
    });

    test('every file lands in staging with a pending upload', () => {
        const pending = pendingUploadsOf(metadataPath);
        expect(pending.map((row) => row.storageKey).sort()).toEqual(fileKeysOf(metadataPath).sort());
        const stagingDir = join(TEST_DATA_DIR, 'home', userId, 'mounts', MOUNT_ID, 'staging');
        for (const row of pending) expect(existsSync(join(stagingDir, row.stagingPath))).toBe(true);
        // The container's data.db is a database and keeps the queue's SQLite guard; the PNG and the
        // text file are plain files, and the guard would drop them before the PUT.
        expect(pending.find((row) => row.storageKey === dataDbKey)?.isDatabase).toBe(1);
        expect(pending.find((row) => row.storageKey === pngKey)?.isDatabase).toBe(0);
        expect(pending.find((row) => row.storageKey === textKey)?.isDatabase).toBe(0);
        // A trashed file and a version snapshot are file rows like any other: both are staged, and
        // the snapshot is a database while the trashed text file is not.
        expect(pending.find((row) => row.storageKey === trashedKey)?.isDatabase).toBe(0);
        expect(pending.find((row) => row.storageKey === versionKey)?.isDatabase).toBe(1);
        // The local data/ tree is not an s3 mount's storage; the bytes belong in the bucket.
        expect(existsSync(join(TEST_DATA_DIR, 'home', userId, 'mounts', MOUNT_ID, 'data'))).toBe(false);
        // thumbs/ sits beside that tree and survives it: the drive route serves thumbnails off the
        // local disk on every backend, and nothing regenerates one.
        expect(existsSync(thumbPath)).toBe(true);
    });

    test('the upload queue drains them to the bucket, plain files included', async () => {
        const home = await getHome(userId);
        // A fresh Mount over the restored metadata.db and the same bucket: init reconciles the
        // pending rows and the queue drains them, exactly as it does after a server restart.
        const { mount: restored } = createHomeFaultMount(home, MOUNT_ID, BACKING);
        await restored.init();
        try {
            await restored.drainPendingUploads({ flushNow: true });

            expect(await bytesInBucket(restored, pngKey)).toEqual(TEST_PNG_BYTES);
            expect(await bytesInBucket(restored, textKey)).toEqual(TEXT_BYTES);
            expect(await bytesInBucket(restored, trashedKey)).toEqual(TEXT_BYTES);
            expect(await bytesInBucket(restored, versionKey)).not.toBeNull();
            const dataDb = await bytesInBucket(restored, dataDbKey);
            expect(dataDb).not.toBeNull();
            expect(new TextDecoder().decode(dataDb!.subarray(0, 15))).toBe('SQLite format 3');
            expect(pendingUploadsOf(metadataPath)).toEqual([]);
        } finally {
            await restored.closeAllDatabases();
        }
    });
});
