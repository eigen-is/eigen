import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { teamOwnerId } from '@workspace/lib/types';
import { getSyntheticTeamUser, TeamHome } from '../lib/home/team-home';
import { getTestContext } from './setup';

// AUDIT 11: TeamHome.updateMount only persisted the change to settings.json; the already-built Drive
// kept a stale MountConfig (quota/name) — or a disabled mount stayed live — until the Home was evicted
// and reloaded. These tests build a TeamHome directly and assert the LIVE Drive reflects an update
// without any evict/reload.
describe('TeamHome.updateMount live-Drive propagation (AUDIT 11)', () => {
    beforeAll(async () => {
        await getTestContext(); // boots the app: server settings + EIGEN_DATA_ROOT
    });

    async function freshTeamHome(): Promise<TeamHome> {
        const owner = teamOwnerId(randomUUID().replace(/-/g, '')); // parseOwnerId wants 32 alnum chars
        const home = new TeamHome(getSyntheticTeamUser(owner, 'Live Update Team'));
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
            await home.shutdown();
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
            await home.shutdown();
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
            await home.shutdown();
        }
    });
});
