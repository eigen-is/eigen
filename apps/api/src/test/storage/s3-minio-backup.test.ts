import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { auth } from '../../lib/auth/auth';
import { extractArtifact, packFolder } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { verifyFolder } from '../../lib/backup/verify';
import { getHome } from '../../lib/home/get-home';
import { Mount } from '../../lib/mount/mount';
import { S3Storage } from '../../lib/storage/s3-storage';
import { registerFaultMount, unregisterFaultMount } from '../fault-storage-helpers';
import {
    assertJson,
    authedRequest,
    driveUpload,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

// The backup round trip against a real bucket, the one thing FaultStorage cannot answer: that the
// archive carries an s3 mount's objects by path, that a fresh extract verifies, and that a restore
// puts the bytes back in the bucket under the keys the restored metadata.db names. Opt-in, exactly
// like s3-minio.test.ts: set S3_TEST_ENDPOINT (e.g. http://localhost:9000); unset or unreachable,
// every test skips.
const endpoint = process.env['S3_TEST_ENDPOINT'];

const s3Config: S3Config = {
    endpoint: endpoint ?? '',
    bucket: process.env['S3_TEST_BUCKET'] ?? 'eigen',
    accessKeyId: process.env['S3_TEST_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_TEST_SECRET_KEY'] ?? 'minioadmin',
    region: 'eu-west-1',
    // Unique per run so concurrent or aborted runs never collide; afterAll deletes what we wrote.
    prefix: `test-backup-${randomUUID()}`,
};

// skipIf is evaluated at registration, so the reachability probe runs at module load. Any HTTP
// response (MinIO answers 403 on /) proves the endpoint is up.
let live = false;
if (!endpoint) {
    console.info('[s3-minio-backup] S3_TEST_ENDPOINT not set — skipping live S3 backup tests (see scripts/s3-local)');
} else {
    try {
        await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
        live = true;
    } catch {
        console.warn(`[s3-minio-backup] S3_TEST_ENDPOINT=${endpoint} unreachable — skipping live S3 backup tests`);
    }
}

const MOUNT_ID = 'backup-minio';
const PASSWORD = 'testpassword123';
const TEXT_BYTES = new TextEncoder().encode('a plain file that has to come back out of the bucket');

function keyOf(metadataPath: string, pathId: string): string {
    const db = openMountMetadata(metadataPath);
    try {
        return db.query<{ file: string }, [string]>('SELECT file FROM paths WHERE id = ?').get(pathId)!.file;
    } finally {
        db.close();
    }
}

function pendingKeys(metadataPath: string): string[] {
    const db = openMountMetadata(metadataPath);
    try {
        return db
            .query<{ storageKey: string }, []>('SELECT storageKey FROM pending_uploads')
            .all()
            .map((row) => row.storageKey);
    } finally {
        db.close();
    }
}

async function bytesInBucket(storage: S3Storage, key: string): Promise<Uint8Array | null> {
    const file = storage.read(key);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
}

describe.skipIf(!live)('Backup round trip on a real S3 mount (MinIO)', () => {
    let userId: string;
    let token: string;
    let mount: Mount;
    let storage: S3Storage;
    let metadataPath: string;
    let artifact: string;
    let pngId: string;
    let textId: string;
    let originalPngKey: string;
    let restoredPngKey: string;
    let restoredTextKey: string;

    beforeAll(async () => {
        await getTestContext();
        const email = `backup-minio-${randomUUID().slice(0, 8)}@test.eigen.is`;
        const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Backup MinIO' } });
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
        const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
        if (!match) throw new Error('no session cookie');
        userId = signUp.user.id;
        token = match[1];

        storage = new S3Storage(s3Config);
        const home = await getHome(userId);
        const config: MountConfig = {
            id: MOUNT_ID,
            name: MOUNT_ID,
            storageType: 's3',
            isDefault: false,
            s3Config,
        };
        mount = new Mount(userId, home.homeDir, config, home.getLocalDatabase.bind(home));
        await mount.init();
        registerFaultMount(home.drive, mount);
        metadataPath = join(home.homeDir, 'mounts', MOUNT_ID, 'metadata.db');

        const root = await assertJson<DrivePath>(await authedRequest(token, `/drive/${userId}/${MOUNT_ID}/root`));
        pngId = (
            await driveUpload<DrivePath>(
                token,
                userId,
                MOUNT_ID,
                root.id,
                new File([TEST_PNG_BYTES], 'bucket.png', { type: 'image/png' }),
            )
        ).id;
        textId = (
            await driveUpload<DrivePath>(
                token,
                userId,
                MOUNT_ID,
                root.id,
                new File([TEXT_BYTES], 'notes.txt', { type: 'text/plain' }),
            )
        ).id;
        // Everything the user uploaded is in the bucket before the backup reads it.
        await mount.drainPendingUploads({ flushNow: true });
        originalPngKey = keyOf(metadataPath, pngId);
        expect(await bytesInBucket(storage, originalPngKey)).toEqual(TEST_PNG_BYTES);
    });

    afterAll(async () => {
        if (!live) return;
        const home = await getHome(userId).catch(() => null);
        if (home) unregisterFaultMount(home.drive, MOUNT_ID);
        await mount?.closeAllDatabases();
        for (const key of [originalPngKey, restoredPngKey, restoredTextKey]) {
            if (key) await storage.delete(key); // best-effort — delete() catches and returns false
        }
        if (artifact) {
            rmSync(join(getBackupsDir(), artifact), { force: true });
            rmSync(join(getBackupsDir(), `${artifact}.manifest.json`), { force: true });
        }
    });

    test('the archive carries the bucket objects by path, and a fresh extract verifies', async () => {
        const staging = mkdtempSync(join(TEST_DATA_DIR, 'minio-backup-'));
        const manifest = await snapshotHome(await getHome(userId), staging);
        const folder = join(staging, buildHomeFolderName(userId));

        expect(manifest.mounts.find((m) => m.id === MOUNT_ID)?.storageType).toBe('s3');
        // Objects live under flat keys in the bucket; the archive holds them by path, which is what
        // makes it storage-independent.
        const prefix = `home/mounts/${MOUNT_ID}/data/`;
        const archived = manifest.entries.map((entry) => entry.path).filter((path) => path.startsWith(prefix));
        expect(archived).toContain(`${prefix}bucket.png`);
        expect(archived).toContain(`${prefix}notes.txt`);
        expect(new Uint8Array(await Bun.file(join(folder, prefix, 'bucket.png')).arrayBuffer())).toEqual(
            TEST_PNG_BYTES,
        );
        expect(new Uint8Array(await Bun.file(join(folder, prefix, 'notes.txt')).arrayBuffer())).toEqual(TEXT_BYTES);

        artifact = buildArtifactName(userId, new Date());
        await packFolder(folder, join(getBackupsDir(), artifact));
        rmSync(staging, { recursive: true, force: true });

        // A verify of a fresh extract is what a restore runs first, and what the admin's Verify
        // button runs: it has to pass on an archive whose bytes came out of a real bucket.
        const extracted = mkdtempSync(join(TEST_DATA_DIR, 'minio-verify-'));
        await extractArtifact(join(getBackupsDir(), artifact), extracted);
        const record = await verifyFolder(join(extracted, buildHomeFolderName(userId)));
        expect(record.failures).toEqual([]);
        expect(record.status).toBe('verified');
        rmSync(extracted, { recursive: true, force: true });
    });

    test('a restore re-uploads every object under a fresh key', async () => {
        // Empty the bucket first, the shape of a restore onto a new server: nothing may pass because
        // it happened to still be there.
        await mount.closeAllDatabases();
        expect(await storage.delete(originalPngKey)).toBe(true);
        expect(await storage.delete(keyOf(metadataPath, textId))).toBe(true);

        await restoreHome(artifact, userId, `minio-restore-${Date.now()}`);

        restoredPngKey = keyOf(metadataPath, pngId);
        restoredTextKey = keyOf(metadataPath, textId);
        // Rekeyed on the way in: an archive restored onto a bucket that may still hold the old
        // objects (a second restore, a shared bucket) must never write over one of them.
        expect(restoredPngKey).not.toBe(originalPngKey);
        expect(await bytesInBucket(storage, originalPngKey)).toBeNull();
        expect(pendingKeys(metadataPath).sort()).toEqual([restoredPngKey, restoredTextKey].sort());

        // The queue a reopened mount stands up is what drains them — no request of its own.
        const home = await getHome(userId);
        const restored = new Mount(
            userId,
            home.homeDir,
            { id: MOUNT_ID, name: MOUNT_ID, storageType: 's3', isDefault: false, s3Config },
            home.getLocalDatabase.bind(home),
        );
        await restored.init();
        try {
            await restored.drainPendingUploads({ flushNow: true });
            expect(restored.pendingUploadCount).toBe(0);
            expect(await bytesInBucket(storage, restoredPngKey)).toEqual(TEST_PNG_BYTES);
            expect(await bytesInBucket(storage, restoredTextKey)).toEqual(TEXT_BYTES);
        } finally {
            await restored.closeAllDatabases();
        }
    });
});
