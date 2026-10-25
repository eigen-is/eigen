import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { teamOwnerId } from '@workspace/lib/types';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import { createMountConfig, Mount } from '../../lib/mount';
import { getTestContext } from '../setup';

// AUDIT 11: TeamHome.updateMount only persisted the change to settings.json; the already-built Drive
// kept a stale MountConfig (quota/name) — or a disabled mount stayed live — until the Home was evicted
// and reloaded. These tests build a TeamHome directly and assert the LIVE Drive reflects an update
// without any evict/reload.
describe('TeamHome.updateMount live-Drive propagation (AUDIT 11)', () => {
    const homeDirs: string[] = [];

    beforeAll(async () => {
        await getTestContext(); // boots the app: server settings + EIGEN_DATA_ROOT
    });

    // The data root is the whole suite's: a later server backup would find these homes and their s3 mount.
    afterAll(() => {
        for (const dir of homeDirs) rmSync(dir, { recursive: true, force: true });
    });

    async function freshTeamHome(): Promise<TeamHome> {
        const owner = teamOwnerId(randomUUID().replace(/-/g, '')); // parseOwnerId wants 32 alnum chars
        const home = new TeamHome(getSyntheticTeamUser(owner, 'Live Update Team'));
        homeDirs.push(home.homeDir);
        await home.init();
        return home;
    }

    test('maxSizeMB + name update reaches the live Drive without a reload', async () => {
        const home = await freshTeamHome();
        try {
            const mount = await home.addMount({ name: 'Shared', maxSizeMB: 200 });
            expect(home.drive.getMountConfig(mount.id).maxSizeMB).toBe(200);

            await home.updateMount(mount.id, { maxSizeMB: 750, name: 'Shared (Big)' });

            // Same Home instance, no evict — the live mount config carries the new quota + name.
            expect(home.drive.getMountConfig(mount.id).maxSizeMB).toBe(750);
            const listed = await home.drive.listMounts();
            expect(listed.find((m) => m.id === mount.id)?.name).toBe('Shared (Big)');
        } finally {
            await home.close();
        }
    });

    test('adding a second mount keeps the first', async () => {
        const home = await freshTeamHome();
        try {
            const first = await home.addMount({ name: 'First', maxSizeMB: 100 });
            const second = await home.addMount({ name: 'Second', maxSizeMB: 200 });

            expect(home.settings.get().mounts?.[first.id]?.name).toBe('First');
            expect(home.settings.get().mounts?.[second.id]?.name).toBe('Second');
            const listed = await home.drive.listMounts();
            expect(listed.map((m) => m.id).sort()).toEqual([first.id, second.id].sort());
        } finally {
            await home.close();
        }
    });

    test('s3Config update rebuilds the live mount around the new storage config', async () => {
        const home = await freshTeamHome();
        try {
            const mount = await home.addMount({ name: 'Repointed', maxSizeMB: 100 });
            const rootBefore = await home.drive.getRootFolder(mount.id);
            expect(rootBefore).not.toBeNull();

            const s3Config = {
                endpoint: 'https://s3.example.com',
                bucket: 'team-bucket',
                prefix: 'eigen/',
                accessKeyId: 'AK',
                secretAccessKey: 'SK',
            };
            await home.updateMount(mount.id, { s3Config });

            // Same Home instance, no evict — the storage config reached the live Drive.
            expect(home.drive.getMountConfig(mount.id).s3Config).toEqual(s3Config);
            // Rebuilt, not dropped: the mount still serves reads from its metadata.db.
            const rootAfter = await home.drive.getRootFolder(mount.id);
            expect(rootAfter?.id).toBe(rootBefore!.id);
            const listed = await home.drive.listMounts();
            expect(listed.find((m) => m.id === mount.id)?.name).toBe('Repointed');
        } finally {
            await home.close();
        }
    });

    test('updateMount rejects an s3Config that fails the connection check, leaving the live mount untouched', async () => {
        // Mirror settings.test.ts's checkS3Connection spy: ok for addMount, then a failed check for
        // the update — deterministic, no network. Pre-fix updateMount never calls the check at all.
        const s3Storage = await import('../../lib/storage/s3-storage');
        const spy = spyOn(s3Storage, 'checkS3Connection')
            .mockResolvedValueOnce({ ok: true, message: 'Connection successful', versioning: 'enabled' })
            .mockResolvedValueOnce({ ok: false, message: 'invalid credentials' });

        const home = await freshTeamHome();
        try {
            const s3Config = {
                endpoint: 'http://127.0.0.1:1',
                bucket: 'team-bucket',
                prefix: '',
                accessKeyId: 'AK',
                secretAccessKey: 'SK',
            };
            const mount = await home.addMount({ name: 'S3 Live', storageType: 's3', s3Config });

            await expect(
                home.updateMount(mount.id, { s3Config: { ...s3Config, secretAccessKey: 'typo' } }),
            ).rejects.toThrow('S3 connection failed');

            // Rejected before persist + push: the live mount still runs on the original config.
            expect(home.drive.getMountConfig(mount.id).s3Config).toEqual(s3Config);
            expect(home.settings.get().mounts?.[mount.id]?.s3Config).toEqual(s3Config);
        } finally {
            spy.mockRestore();
            await home.close();
        }
    });

    test('a rename made while a storage change waits on its S3 check is kept', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const { promise: checked, resolve: passCheck } = Promise.withResolvers<void>();
        const spy = spyOn(s3Storage, 'checkS3Connection')
            .mockResolvedValueOnce({ ok: true, message: 'Connection successful', versioning: 'enabled' })
            .mockImplementationOnce(async () => {
                await checked;
                return { ok: true, message: 'Connection successful', versioning: 'enabled' };
            });

        const home = await freshTeamHome();
        try {
            const s3Config = {
                endpoint: 'http://127.0.0.1:1',
                bucket: 'team-bucket',
                prefix: '',
                accessKeyId: 'AK',
                secretAccessKey: 'SK',
            };
            const mount = await home.addMount({ name: 'Before', storageType: 's3', s3Config });

            const repointed = { ...s3Config, bucket: 'other-bucket' };
            const storageChange = home.updateMount(mount.id, { s3Config: repointed });
            await home.updateMount(mount.id, { name: 'After' });
            passCheck();
            await storageChange;

            expect(home.settings.get().mounts?.[mount.id]).toMatchObject({ name: 'After', s3Config: repointed });
            const listed = await home.drive.listMounts();
            expect(listed.find((m) => m.id === mount.id)?.name).toBe('After');
        } finally {
            spy.mockRestore();
            await home.close();
        }
    });

    test('two changes to one mount at once both land', async () => {
        const home = await freshTeamHome();
        try {
            const mount = await home.addMount({ name: 'Before', maxSizeMB: 100 });

            await Promise.all([
                home.updateMount(mount.id, { name: 'After' }),
                home.updateMount(mount.id, { maxSizeMB: 300 }),
            ]);

            expect(home.settings.get().mounts?.[mount.id]).toMatchObject({ name: 'After', maxSizeMB: 300 });
            expect(home.drive.getMountConfig(mount.id).maxSizeMB).toBe(300);
            const listed = await home.drive.listMounts();
            expect(listed.find((m) => m.id === mount.id)?.name).toBe('After');
        } finally {
            await home.close();
        }
    });

    test('disabling a mount whose databases fail to close still drops it', async () => {
        const home = await freshTeamHome();
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const mount = await home.addMount({ name: 'Stuck', maxSizeMB: 100 });
            const [live] = home.drive.getMounts();
            spyOn(live, 'closeAllDatabases').mockRejectedValueOnce(new Error('disk gone'));

            await home.updateMount(mount.id, { enabled: false });

            expect(() => home.drive.getMountConfig(mount.id)).toThrow('Mount not found');
            expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes('disk gone')))).toBe(true);
        } finally {
            errors.mockRestore();
            await home.close();
        }
    });

    test('disabling a mount drops it from the live Drive', async () => {
        const home = await freshTeamHome();
        try {
            const mount = await home.addMount({ name: 'Temp', maxSizeMB: 100 });
            expect(home.drive.getMountConfig(mount.id).maxSizeMB).toBe(100);

            await home.updateMount(mount.id, { enabled: false });

            expect(() => home.drive.getMountConfig(mount.id)).toThrow('Mount not found');
            const listed = await home.drive.listMounts();
            expect(listed.find((m) => m.id === mount.id)).toBeUndefined();
        } finally {
            await home.close();
        }
    });

    // The Drive is called directly, so both changes reach it at the same moment.
    test('two storage changes at once leave one open mount, on the change made last', async () => {
        const home = await freshTeamHome();
        const built: Mount[] = [];
        const init = Mount.prototype.init;
        const spy = spyOn(Mount.prototype, 'init').mockImplementation(function (this: Mount) {
            built.push(this);
            return init.call(this);
        });
        try {
            const settings = await home.addMount({ name: 'Raced', maxSizeMB: 100 });
            built.length = 0;
            const repointed = (bucket: string) =>
                createMountConfig(settings.id, {
                    ...settings,
                    s3Config: {
                        endpoint: 'https://s3.example.com',
                        bucket,
                        prefix: '',
                        accessKeyId: 'AK',
                        secretAccessKey: 'SK',
                    },
                });

            await Promise.all([
                home.drive.updateMount(repointed('first'), true),
                home.drive.updateMount(repointed('second'), true),
            ]);

            expect(built).toHaveLength(2);
            expect(built.filter((m) => !m.closing)).toEqual(home.drive.getMounts());
            expect(home.drive.getMountConfig(settings.id).s3Config?.bucket).toBe('second');
        } finally {
            spy.mockRestore();
            await home.close();
        }
    });
});
