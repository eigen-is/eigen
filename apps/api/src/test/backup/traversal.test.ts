import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { auth } from '../../lib/auth/auth';
import { packFolder, readArtifactManifest } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir, PRE_RESTORE_SUFFIX } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { deleteSafetyCopy } from '../../lib/backup/safety-copy';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import * as verifyModule from '../../lib/backup/verify';
import { verifyFolder } from '../../lib/backup/verify';
import { getHome } from '../../lib/home/get-home';
import { createMountConfig } from '../../lib/mount';
import * as mountHelpers from '../../lib/mount/helpers';
import { assertJson, authedRequest, driveUpload, getTestContext, TEST_DATA_DIR, TEST_PNG_BYTES } from '../setup';

// An archive comes from outside — an admin uploads one, or copies one in by scp — so every segment
// it names is untrusted input. A manifest that spells a mount id as `../../{victim}/mounts/{id}`
// used to send the restore straight into another user's live home: it cleared their pending
// uploads, rekeyed every row of their paths table and deleted their data/ tree, and reported done.

const PASSWORD = 'testpassword123';

type TestUser = { id: string; email: string; sessionToken: string };

async function createUser(email: string, name: string): Promise<TestUser> {
    const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
    const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`no session cookie for ${email}`);
    return { id: signUp.user.id, email, sessionToken: match[1] };
}

describe('Backup refuses an archive that names another home', () => {
    let attacker: TestUser;
    let victim: TestUser;
    let victimMountId: string;
    let victimFileId: string;
    let hostileMountId: string;
    let folder: string;
    let manifest: BackupManifest;

    async function victimFileStatus(): Promise<number> {
        const res = await authedRequest(
            victim.sessionToken,
            `/drive/${victim.id}/${victimMountId}/file/${victimFileId}/download`,
        );
        return res.status;
    }

    beforeAll(async () => {
        await getTestContext();
        attacker = await createUser('backup-traversal-attacker@test.eigen.is', 'Traversal Attacker');
        victim = await createUser('backup-traversal-victim@test.eigen.is', 'Traversal Victim');

        const victimMounts = await assertJson<{ id: string }[]>(
            await authedRequest(victim.sessionToken, `/drive/${victim.id}/mounts`),
        );
        victimMountId = victimMounts[0].id;
        const victimRoot = await assertJson<DrivePath>(
            await authedRequest(victim.sessionToken, `/drive/${victim.id}/${victimMountId}/root`),
        );
        victimFileId = (
            await driveUpload<DrivePath>(
                victim.sessionToken,
                victim.id,
                victimMountId,
                victimRoot.id,
                new File([TEST_PNG_BYTES], 'do-not-touch.png', { type: 'image/png' }),
            )
        ).id;
        expect(await victimFileStatus()).toBe(200);

        // The attacker's own archive, with one line added to its manifest. `s3` is the destructive
        // branch: it rewrites every storage key and then deletes the data/ tree it read them from.
        hostileMountId = `../../${victim.id}/mounts/${victimMountId}`;
        const staging = mkdtempSync(join(TEST_DATA_DIR, 'traversal-'));
        manifest = await snapshotHome(await getHome(attacker.id), staging);
        manifest.mounts.push({ id: hostileMountId, storageType: 's3', files: 0, bytes: 0 });
        folder = join(staging, buildHomeFolderName(attacker.id));
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    });

    test('verify fails on the folder before anything reads it', async () => {
        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures.join(' ')).toContain('manifest');
    });

    test('a restore of it throws and the other home is untouched', async () => {
        const name = buildArtifactName(attacker.id, new Date());
        const artifactPath = join(getBackupsDir(), name);
        await packFolder(folder, artifactPath);
        try {
            // The upload route reads the manifest out of the archive; a hostile one is not an
            // archive this server accepts at all.
            await expect(readArtifactManifest(artifactPath)).rejects.toThrow(/not an Eigen backup archive/);

            await expect(restoreHome(name, attacker.id, `traversal-${Date.now()}`)).rejects.toThrow(/manifest/);

            expect(await victimFileStatus()).toBe(200);
            const victimData = join(TEST_DATA_DIR, 'home', victim.id, 'mounts', victimMountId, 'data');
            expect(existsSync(victimData)).toBe(true);
        } finally {
            rmSync(artifactPath, { force: true });
        }
    });

    test('a safety copy whose settings.json names another home deletes nothing of it', async () => {
        // settings.json is archive-derived too: a restored home's copy is whatever the archive said,
        // and deleteSafetyCopy reads its mount ids to decide which bucket objects are garbage.
        const homeDir = join(TEST_DATA_DIR, 'home', attacker.id);
        const copyName = `${attacker.id}${PRE_RESTORE_SUFFIX}20200101-000000`;
        const copyDir = join(TEST_DATA_DIR, 'home', copyName);
        mkdirSync(copyDir, { recursive: true });
        writeFileSync(
            join(copyDir, 'settings.json'),
            JSON.stringify({
                mounts: {
                    [hostileMountId]: {
                        storageType: 's3',
                        enabled: true,
                        s3Config: {
                            endpoint: 'http://127.0.0.1:1',
                            bucket: 'nowhere',
                            accessKeyId: 'x',
                            secretAccessKey: 'y',
                        },
                    },
                },
            }),
        );

        // Nothing of that mount is ever resolved, so no storage is built for it and no object of
        // another home is judged garbage. The spy is what makes "never reached it" observable.
        const spy = spyOn(mountHelpers, 'createMountStorage');
        let storagesBuilt = -1;
        try {
            await deleteSafetyCopy(copyDir, homeDir);
            storagesBuilt = spy.mock.calls.length;
        } finally {
            // Read the count before restoring: mockRestore drops the recorded calls with it.
            spy.mockRestore();
        }

        expect(storagesBuilt).toBe(0);
        expect(existsSync(copyDir)).toBe(false);
        expect(await victimFileStatus()).toBe(200);
    });
});

// The archive's own metadata.db is untrusted input in the same way. A live `paths` row can never
// hold a separator, a `..` or a control character (mount/helpers validateName wrote it); an
// archived one can. A doctored `file` moved a restored file OUT of the mount over anything the
// server can write, and a doctored `name` moved an arbitrary server file INTO the restored home.
describe('Backup refuses an archive whose paths table leaves the mount', () => {
    const OUTSIDE_PATH = join(TEST_DATA_DIR, 'traversal-outside.txt');
    const OUTSIDE_CONTENT = 'not the archive to move';
    const LOCAL_MOUNT_ID = 'traversal-local';

    let owner: TestUser;
    let keyMountId: string;
    let keyFileId: string;
    let localFileId: string;

    function escapePathFrom(mountId: string): string {
        const dataDir = join(TEST_DATA_DIR, 'home', owner.id, 'mounts', mountId, 'data');
        return relative(dataDir, OUTSIDE_PATH);
    }

    // The attacker's own archive with one `paths` row doctored, its manifest entry restated so
    // verify's transport stage passes and the row itself is what has to be caught.
    async function hostileArchive(mountId: string, column: 'file' | 'name' | 'id', value: string, rowId: string) {
        const staging = mkdtempSync(join(TEST_DATA_DIR, 'traversal-rows-'));
        const manifest = await snapshotHome(await getHome(owner.id), staging);
        const hostileFolder = join(staging, buildHomeFolderName(owner.id));
        const rel = `home/mounts/${mountId}/metadata.db`;
        const db = new Database(join(hostileFolder, rel), { readwrite: true, create: false });
        try {
            db.run(`UPDATE paths SET ${column} = ? WHERE id = ?`, [value, rowId]);
        } finally {
            db.close();
        }
        const entry = manifest.entries.find((candidate) => candidate.path === rel);
        if (!entry) throw new Error(`${rel} is not in the manifest`);
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(new Uint8Array(await Bun.file(join(hostileFolder, rel)).arrayBuffer()));
        entry.bytes = Bun.file(join(hostileFolder, rel)).size;
        entry.sha256 = hasher.digest('hex');
        writeFileSync(join(hostileFolder, 'manifest.json'), JSON.stringify(manifest, null, 2));
        return hostileFolder;
    }

    // One artifact per hostile folder. The stamp is a second wide, so each one gets its own.
    let packed = 0;
    async function packHostile(hostileFolder: string): Promise<string> {
        const name = buildArtifactName(owner.id, new Date(Date.now() + packed++ * 1000));
        await packFolder(hostileFolder, join(getBackupsDir(), name));
        return name;
    }

    beforeAll(async () => {
        owner = await createUser('backup-traversal-rows@test.eigen.is', 'Traversal Rows');
        writeFileSync(OUTSIDE_PATH, OUTSIDE_CONTENT);

        // The harness's default mount is local-key: its storage key IS `paths.file`.
        const mounts = await assertJson<{ id: string }[]>(
            await authedRequest(owner.sessionToken, `/drive/${owner.id}/mounts`),
        );
        keyMountId = mounts[0].id;
        const keyRoot = await assertJson<DrivePath>(
            await authedRequest(owner.sessionToken, `/drive/${owner.id}/${keyMountId}/root`),
        );
        keyFileId = (
            await driveUpload<DrivePath>(
                owner.sessionToken,
                owner.id,
                keyMountId,
                keyRoot.id,
                new File([TEST_PNG_BYTES], 'flat.png', { type: 'image/png' }),
            )
        ).id;

        // And a path-based mount beside it, where the archive tree is built from `paths.name`.
        const home = await getHome(owner.id);
        const settings = await home.settings.set({
            mounts: {
                [LOCAL_MOUNT_ID]: { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Traversal Local' },
            },
        });
        await home.drive.addMount(createMountConfig(LOCAL_MOUNT_ID, settings.mounts![LOCAL_MOUNT_ID]));
        const localRoot = await assertJson<DrivePath>(
            await authedRequest(owner.sessionToken, `/drive/${owner.id}/${LOCAL_MOUNT_ID}/root`),
        );
        localFileId = (
            await driveUpload<DrivePath>(
                owner.sessionToken,
                owner.id,
                LOCAL_MOUNT_ID,
                localRoot.id,
                new File([TEST_PNG_BYTES], 'tree.png', { type: 'image/png' }),
            )
        ).id;
    });

    afterAll(() => {
        rmSync(OUTSIDE_PATH, { force: true });
    });

    test('verify names the row whose file leaves the mount', async () => {
        const folder = await hostileArchive(keyMountId, 'file', escapePathFrom(keyMountId), keyFileId);
        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures.join(' ')).toContain(keyFileId);
    });

    test('verify names the row whose name leaves the mount', async () => {
        const folder = await hostileArchive(LOCAL_MOUNT_ID, 'name', escapePathFrom(LOCAL_MOUNT_ID), localFileId);
        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures.join(' ')).toContain(localFileId);
    });

    // An id is a path segment too: a trashed row is archived under `.trash/{id}.{ext}` and a restored
    // s3 row takes an object key built from it.
    test('verify names the row whose id leaves the mount', async () => {
        const folder = await hostileArchive(keyMountId, 'id', escapePathFrom(keyMountId), keyFileId);
        const record = await verifyFolder(folder);
        expect(record.status).toBe('failed');
        expect(record.failures.join(' ')).toContain('unusable id');
    });

    test('a restore of one throws and the file outside the home is untouched', async () => {
        const name = await packHostile(await hostileArchive(keyMountId, 'file', escapePathFrom(keyMountId), keyFileId));
        await expect(restoreHome(name, owner.id, `traversal-rows-${randomUUID()}`)).rejects.toThrow();
        expect(readFileSync(OUTSIDE_PATH, 'utf8')).toBe(OUTSIDE_CONTENT);
        expect((await authedRequest(owner.sessionToken, `/drive/${owner.id}/mounts`)).status).toBe(200);
    });

    // Verify is the gate, and the materialization is the second lock on the same door: every source,
    // target and directory it builds out of the archive's rows is resolved against the mount's own
    // data folder before a byte moves.
    test('the materialization refuses the rows even with verify silenced', async () => {
        const name = await packHostile(
            await hostileArchive(LOCAL_MOUNT_ID, 'name', escapePathFrom(LOCAL_MOUNT_ID), localFileId),
        );
        const spy = spyOn(verifyModule, 'verifyFolder').mockResolvedValue({
            status: 'verified',
            checkedAt: new Date(),
            failures: [],
        });
        try {
            await expect(restoreHome(name, owner.id, `traversal-rows-${randomUUID()}`)).rejects.toThrow();
        } finally {
            spy.mockRestore();
        }
        expect(existsSync(OUTSIDE_PATH)).toBe(true);
        expect(readFileSync(OUTSIDE_PATH, 'utf8')).toBe(OUTSIDE_CONTENT);
        // The rollback put the home back: the mount that was never touched still answers.
        expect((await authedRequest(owner.sessionToken, `/drive/${owner.id}/mounts`)).status).toBe(200);
    });
});
