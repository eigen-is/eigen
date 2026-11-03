import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import { PATHS } from '../../lib/config/paths';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import { createMountConfig, Mount, newMountSettings } from '../../lib/mount';
import { SETTLE_BOUND_MS } from '../fault-storage-helpers';
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
        const owner = teamOwnerId(crypto.randomUUID().replace(/-/g, '')); // parseOwnerId wants 32 alnum chars
        const home = new TeamHome(getSyntheticTeamUser(owner, 'Live Update Team'));
        homeDirs.push(home.homeDir);
        await home.init();
        return home;
    }

    // A gate that never opens fails the test before bun's own timeout, so its finally still restores the spies.
    function within<T>(promise: Promise<T>, ms = SETTLE_BOUND_MS): Promise<T> {
        return Promise.race([
            promise,
            Bun.sleep(ms).then(() => {
                throw new Error(`Timed out after ${ms} ms`);
            }),
        ]);
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

    // The close only closes the mounts the Drive knows, and the new mount is not one of them yet.
    test('a storage change the home starts closing under leaves no mount open', async () => {
        const home = await freshTeamHome();
        const drive = home.drive;
        const settings = await home.addMount({ name: 'Closing', maxSizeMB: 100 });
        const built: Mount[] = [];
        const { promise: opened, resolve: open } = Promise.withResolvers<void>();
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const init = Mount.prototype.init;
        const spy = spyOn(Mount.prototype, 'init').mockImplementation(async function (this: Mount) {
            built.push(this);
            await init.call(this);
            open();
            await held;
        });
        try {
            const repointed = createMountConfig(settings.id, {
                ...settings,
                s3Config: {
                    endpoint: 'https://s3.example.com',
                    bucket: 'closing',
                    prefix: '',
                    accessKeyId: 'AK',
                    secretAccessKey: 'SK',
                },
            });
            const repointing = drive.updateMount(repointed, true);
            await opened;
            const closing = home.close();
            release();

            await expect(repointing).rejects.toMatchObject({ status: 503, message: 'Home is closing' });
            await closing;
            expect(built).toHaveLength(1);
            expect(built[0].closing).toBe(true);
            expect(drive.getMounts()).toEqual([]);
        } finally {
            spy.mockRestore();
            await home.close();
        }
    });

    test('a closing home builds no new mount', async () => {
        const home = await freshTeamHome();
        const drive = home.drive;
        const spy = spyOn(Mount.prototype, 'init');
        try {
            const closing = home.close();
            await expect(
                drive.addMount(createMountConfig('late', { ...newMountSettings(), name: 'Late' })),
            ).rejects.toMatchObject({ status: 503, message: 'Home is closing' });
            await closing;
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test('the home close waits for the mount that addMount closes', async () => {
        const home = await freshTeamHome();
        const drive = home.drive;
        const { promise: started, resolve: start } = Promise.withResolvers<Mount>();
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const { promise: tearingDown, resolve: tearDown } = Promise.withResolvers<void>();
        const { promise: torn, resolve: finishTeardown } = Promise.withResolvers<void>();
        const init = Mount.prototype.init;
        const initSpy = spyOn(Mount.prototype, 'init').mockImplementation(async function (this: Mount) {
            await init.call(this);
            start(this);
            await held;
        });
        const closeAllDatabases = Mount.prototype.closeAllDatabases;
        const closeSpy = spyOn(Mount.prototype, 'closeAllDatabases').mockImplementation(async function (this: Mount) {
            if (this.id === 'orphan') {
                tearDown();
                await torn;
            }
            return closeAllDatabases.call(this);
        });
        try {
            const adding = drive.addMount(createMountConfig('orphan', { ...newMountSettings(), name: 'Orphan' }));
            // A failed check below must not leave this rejection unhandled in the next test.
            adding.catch(() => {});
            const mount = await within(started);
            const closing = home.close();
            release();
            await within(tearingDown);

            const first = await Promise.race([closing.then(() => 'closed'), Bun.sleep(200).then(() => 'waiting')]);
            expect(first).toBe('waiting');

            finishTeardown();
            await expect(within(adding)).rejects.toMatchObject({ status: 503, message: 'Home is closing' });
            await within(closing);
            expect(mount.closing).toBe(true);
            expect(drive.getMounts()).toEqual([]);
        } finally {
            release();
            finishTeardown();
            initSpy.mockRestore();
            closeSpy.mockRestore();
            await within(home.close());
        }
    });

    // The close begins after the open passed its closing check, so the open itself goes through.
    test('a close that begins while metadata.db opens answers 503', async () => {
        const home = await freshTeamHome();
        const drive = home.drive;
        const built: Mount[] = [];
        const { promise: opened, resolve: open } = Promise.withResolvers<void>();
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const metadataDb = path.join(PATHS.DRIVE.ROOT, 'opening', PATHS.DRIVE.METADATA_DB);
        const getLocalDatabase = home.getLocalDatabase.bind(home);
        const openSpy = spyOn(home, 'getLocalDatabase').mockImplementation(async (config, relativePath) => {
            const db = await getLocalDatabase(config, relativePath);
            if (relativePath === metadataDb) {
                open();
                await held;
            }
            return db;
        });
        const init = Mount.prototype.init;
        const initSpy = spyOn(Mount.prototype, 'init').mockImplementation(function (this: Mount) {
            built.push(this);
            return init.call(this);
        });
        try {
            const adding = drive.addMount(createMountConfig('opening', { ...newMountSettings(), name: 'Opening' }));
            // A failed check below must not leave this rejection unhandled in the next test.
            adding.catch(() => {});
            await within(opened);
            const closing = home.close();
            // Time for a close that does not wait to close metadata.db under the mount.
            await Bun.sleep(100);
            release();

            await expect(within(adding)).rejects.toMatchObject({ status: 503, message: 'Home is closing' });
            await within(closing);
            expect(built).toHaveLength(1);
            expect(built[0].closing).toBe(true);
            expect(drive.getMounts()).toEqual([]);
        } finally {
            release();
            openSpy.mockRestore();
            initSpy.mockRestore();
            await within(home.close());
        }
    });
});
