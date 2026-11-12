import { afterAll, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { teamOwnerId } from '@workspace/lib/types';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import { createMountConfig, Mount, newMountSettings } from '../../lib/mount';
import * as thumbnails from '../../lib/shared/thumbnails';
import { settlesWithin } from '../../utils/timing';
import { createGetLocalDatabase, SETTLE_BOUND_MS } from '../fault-storage-helpers';
import { createTestMountConfig, seedFile } from '../mount-test-helpers';
import { getTestContext } from '../setup';

// What a mount runs in the background, such as a thumbnail or the purge of expired trash, ends before
// its databases close. Nothing of it is left to run against a closed metadata.db.
describe('the background jobs of a mount', () => {
    const MOUNT_DIR = join(import.meta.dir, `../../../../../data-test/test-mount-background-${Date.now()}`);
    const homeDirs: string[] = [];

    beforeAll(async () => {
        await getTestContext();
        mkdirSync(MOUNT_DIR, { recursive: true });
    });

    afterAll(() => {
        for (const dir of [MOUNT_DIR, ...homeDirs]) rmSync(dir, { recursive: true, force: true });
    });

    async function freshTeamHome(): Promise<TeamHome> {
        const owner = teamOwnerId(crypto.randomUUID().replace(/-/g, ''));
        const home = new TeamHome(getSyntheticTeamUser(owner, 'Background Team'));
        homeDirs.push(home.homeDir);
        await home.init();
        return home;
    }

    // The clock stands still and the mount's own close fails, so a timer that opening the mount left behind is
    // still due after the home closed metadata.db.
    test('opening a mount leaves no timer behind that runs once the home closed metadata.db', async () => {
        const home = await freshTeamHome();
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        jest.useFakeTimers();
        try {
            await home.drive.addMount(createMountConfig('fresh', { ...newMountSettings(), name: 'Fresh' }));
            const [mount] = home.drive.getMounts();
            spyOn(mount, 'closeAllDatabases').mockRejectedValueOnce(new Error('disk gone'));

            await home.close();
            jest.advanceTimersByTime(1_000);

            expect(errors.mock.calls.map((call) => String(call[0]))).toEqual(['Failed to close mount databases:']);
        } finally {
            jest.useRealTimers();
            errors.mockRestore();
            await home.close();
        }
    });

    test('a home close waits for a thumbnail job, which writes its row before metadata.db closes', async () => {
        const home = await freshTeamHome();
        const { promise: started, resolve: start } = Promise.withResolvers<void>();
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const save = spyOn(thumbnails, 'saveThumbnail').mockImplementation(async (_thumbsDir, pathId) => {
            start();
            await held;
            return {
                fileName: `${pathId}.webp`,
                data: Buffer.alloc(0),
                width: 4,
                height: 3,
                hasAlpha: false,
                frameCount: 1,
            };
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await home.drive.addMount(createMountConfig('thumbs', { ...newMountSettings(), name: 'Thumbs' }));
            const [mount] = home.drive.getMounts();
            const root = await home.drive.getRootFolder(mount.id);
            const file = await home.drive.createFileFromData(
                mount.id,
                root?.id ?? '',
                'picture.png',
                'image/png',
                Buffer.from('not a real picture'),
                home.user,
            );
            await started;

            const order: string[] = [];
            const updatePath = mount.updatePath.bind(mount);
            spyOn(mount, 'updatePath').mockImplementation(async (...args) => {
                const updated = await updatePath(...args);
                order.push(`row ${updated.thumbnail}`);
                return updated;
            });
            const closing = home.close().then(() => order.push('closed'));

            expect(await settlesWithin(closing, 100)).toBe(false);
            expect(order).toEqual([]);

            release();
            expect(await settlesWithin(closing, SETTLE_BOUND_MS)).toBe(true);
            await Bun.sleep(20);

            expect(order).toEqual([`row ${file.id}.webp`, 'closed']);
            expect(errors.mock.calls).toEqual([]);
        } finally {
            release();
            save.mockRestore();
            errors.mockRestore();
            await home.close();
        }
    });

    test('a mount close waits for the trash purge in flight and stops it before the next item', async () => {
        const config = createTestMountConfig(`purge-${Date.now()}`, 'local-key');
        const first = new Mount('owner-background', MOUNT_DIR, config, createGetLocalDatabase(MOUNT_DIR));
        await first.init();
        const root = await first.getRootFolder();
        const expired = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
        const ids: string[] = [];
        for (const name of ['one.txt', 'two.txt']) {
            const id = await seedFile(first, root?.id ?? '', name, 'text/plain', 1, Buffer.from('x'));
            await first.trashPath(id);
            await first.updatePath(id, { trashedAt: expired });
            ids.push(id);
        }
        await first.closeAllDatabases();

        const mount = new Mount('owner-background', MOUNT_DIR, config, createGetLocalDatabase(MOUNT_DIR));
        const { promise: started, resolve: start } = Promise.withResolvers<void>();
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        const deletePath = mount.deletePath.bind(mount);
        const deleted: string[] = [];
        spyOn(mount, 'deletePath').mockImplementation(async (pathId) => {
            start();
            await held;
            await deletePath(pathId);
            deleted.push(pathId);
        });
        try {
            await mount.init();
            await started;
            const closing = mount.closeAllDatabases();

            expect(await settlesWithin(closing, 100)).toBe(false);

            release();
            expect(await settlesWithin(closing, SETTLE_BOUND_MS)).toBe(true);
            await Bun.sleep(20);

            expect(deleted).toHaveLength(1);
            const left = await Promise.all(ids.map((id) => mount.getPath(id)));
            expect(left.filter((row) => row !== null)).toHaveLength(1);
        } finally {
            release();
        }
    });
});
