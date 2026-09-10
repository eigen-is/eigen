import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import type { DrivePath } from '@workspace/lib/types/drive';
import { auth } from '../../lib/auth/auth';
import { packFolder, readArtifactManifest } from '../../lib/backup/archive';
import { deleteSafetyCopy } from '../../lib/backup/artifacts';
import { buildArtifactName, buildHomeFolderName, getBackupsDir, PRE_RESTORE_SUFFIX } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { verifyFolder } from '../../lib/backup/verify';
import { getHome } from '../../lib/home/get-home';
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
