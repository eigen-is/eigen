import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { S3Config } from '@workspace/lib/types/mount';
import { teamOwnerId } from '@workspace/lib/types/owner';
import type { MountSettings } from '@workspace/lib/types/settings';
import { PATHS } from '../../lib/config/paths';
import { getPublicConfig } from '../../lib/config/server-config';
import { evictHome, getTeamHome } from '../../lib/home/get-home';
import type { TeamHome } from '../../lib/home/team-home';
import { LocalStorage } from '../../lib/storage/local-storage';
import { FakeS3Server } from '../fake-s3-server';
import {
    addMember,
    assertJson,
    authedRequest,
    createTeam,
    driveUpload,
    eventually,
    getTestContext,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

// A team mount's storage change or on/off switch saves the settings and unloads the team's home, so the next request
// opens it on the new settings. A name or quota change reaches the live mount and keeps the home.
describe('Changing a team mount', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let orgId: string;
    const backings = ['team-mount-a', 'team-mount-b'].map((name) => join(TEST_DATA_DIR, name));
    const buckets = backings.map((backing) => new FakeS3Server(new LocalStorage(backing)));
    let bucketA: S3Config;
    let bucketB: S3Config;
    const owners: string[] = [];

    beforeAll(async () => {
        ctx = await getTestContext();
        orgId = getPublicConfig().orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        [bucketA, bucketB] = await Promise.all(buckets.map((bucket) => bucket.start()));
    });

    // The homes close before their buckets stop, so their last syncs find a bucket.
    afterAll(async () => {
        await Promise.all(owners.map((ownerId) => evictHome(ownerId)));
        await Promise.all(buckets.map((bucket) => bucket.stop()));
        for (const backing of backings) rmSync(backing, { recursive: true, force: true });
    });

    async function newTeam(): Promise<{ ownerId: string; home: TeamHome }> {
        const teamId = await createTeam(ctx, orgId, `Mount Team ${crypto.randomUUID().slice(0, 6)}`);
        await addMember(ctx, teamId, ctx.alice.user.id);
        const ownerId = teamOwnerId(teamId);
        owners.push(ownerId);
        return { ownerId, home: await getTeamHome(ownerId) };
    }

    async function upload(ownerId: string, mountId: string, name: string): Promise<DrivePath> {
        const root = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ownerId}/${mountId}/root`),
        );
        return driveUpload(ctx.alice.user.sessionToken, ownerId, mountId, root.id, new File([TEST_PNG_BYTES], name));
    }

    async function names(home: TeamHome, mountId: string): Promise<string[]> {
        const root = await home.drive.getRootFolder(mountId);
        return (await home.drive.getFolderContents(mountId, root!.id)).map((path) => path.name);
    }

    function objectCount(backing: string): number {
        return readdirSync(backing, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
    }

    function okS3Check() {
        return import('../../lib/storage/s3-storage').then((s3Storage) =>
            spyOn(s3Storage, 'checkS3Connection').mockResolvedValue({
                ok: true,
                message: 'Connection successful',
                versioning: 'enabled',
            }),
        );
    }

    test('a new bucket unloads the home, and the next home writes to the new bucket', async () => {
        const check = await okS3Check();
        try {
            const { ownerId, home } = await newTeam();
            const mount = await home.addMount({ name: 'Bucket', storageType: 's3', s3Config: bucketA });
            await upload(ownerId, mount.id, 'before.png');
            const inA = await eventually(async () => objectCount(backings[0]) || undefined, 'the first upload');

            const updated = await home.updateMount(mount.id, { s3Config: bucketB });

            expect(updated.s3Config).toEqual(bucketB);
            expect(home.closing).toBe(true);
            const next = await getTeamHome(ownerId);
            expect(next).not.toBe(home);
            expect(next.drive.getMountConfig(mount.id).s3Config).toEqual(bucketB);
            // The rows stay with the mount, the bytes written before stay in the old bucket.
            expect(await names(next, mount.id)).toEqual(['before.png']);
            expect(objectCount(backings[0])).toBeGreaterThanOrEqual(inA);
            const inB = objectCount(backings[1]);
            await upload(ownerId, mount.id, 'after.png');
            await eventually(async () => (objectCount(backings[1]) > inB ? true : undefined), 'the upload to B');
        } finally {
            check.mockRestore();
        }
    });

    test('off then on through the route unloads the home each time, and the files are back', async () => {
        const { ownerId, home } = await newTeam();
        const mount = await home.addMount({ name: 'Toggled', storageType: 'local' });
        await upload(ownerId, mount.id, 'kept.png');
        const toggle = async (enabled: boolean): Promise<MountSettings> =>
            assertJson<MountSettings>(
                await authedRequest(ctx.alice.user.sessionToken, `/team/${ownerId}/mount/${mount.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                }),
            );

        // The request that unloads the home answers from the saved settings, not with the closing home's 503.
        expect((await toggle(false)).enabled).toBe(false);
        expect(home.closing).toBe(true);
        const off = await getTeamHome(ownerId);
        expect(() => off.drive.getMountConfig(mount.id)).toThrow('Mount not found');

        expect((await toggle(true)).enabled).toBe(true);
        expect(off.closing).toBe(true);
        expect(await names(await getTeamHome(ownerId), mount.id)).toEqual(['kept.png']);
    });

    test('a bucket that fails its check changes nothing and keeps the home', async () => {
        const s3Storage = await import('../../lib/storage/s3-storage');
        const check = spyOn(s3Storage, 'checkS3Connection')
            .mockResolvedValueOnce({ ok: true, message: 'Connection successful', versioning: 'enabled' })
            .mockResolvedValueOnce({ ok: false, message: 'invalid credentials' });
        try {
            const { ownerId, home } = await newTeam();
            const mount = await home.addMount({ name: 'Checked', storageType: 's3', s3Config: bucketA });

            await expect(
                home.updateMount(mount.id, { s3Config: { ...bucketA, secretAccessKey: 'typo' } }),
            ).rejects.toThrow('S3 connection failed');

            expect(home.closing).toBe(false);
            expect(await getTeamHome(ownerId)).toBe(home);
            expect(home.settings.get().mounts?.[mount.id]?.s3Config).toEqual(bucketA);
            expect(home.drive.getMountConfig(mount.id).s3Config).toEqual(bucketA);
        } finally {
            check.mockRestore();
        }
    });

    test('a name or quota change keeps the home and its open document', async () => {
        const check = await okS3Check();
        try {
            const { ownerId, home } = await newTeam();
            const mount = await home.addMount({ name: 'Before', storageType: 's3', s3Config: bucketA });
            const root = await home.drive.getRootFolder(mount.id);
            const doc = await home.drive.create(mount.id, root!.id, 'open', 'doc', home.user);
            await home.drive.getCollabDocument(mount.id, doc.id);

            // The edit dialog sends the saved bucket along with every rename.
            await Promise.all([
                home.updateMount(mount.id, { name: 'After', s3Config: bucketA }),
                home.updateMount(mount.id, { maxSizeMB: 750 }),
            ]);

            expect(home.closing).toBe(false);
            expect(await getTeamHome(ownerId)).toBe(home);
            expect(home.drive.hasCollabDocument(mount.id, doc.id)).toBe(true);
            expect(home.drive.getMountConfig(mount.id).maxSizeMB).toBe(750);
            expect((await home.drive.listMounts()).find((listed) => listed.id === mount.id)?.name).toBe('After');
        } finally {
            check.mockRestore();
        }
    });

    test('a document open during a storage change closes with its edits saved', async () => {
        const { ownerId, home } = await newTeam();
        const mount = await home.addMount({ name: 'Docs', storageType: 'local' });
        const root = await home.drive.getRootFolder(mount.id);
        const created = await home.drive.create(mount.id, root!.id, 'edited', 'doc', home.user);
        const doc = await home.drive.getCollabDocument(mount.id, created.id);
        doc.doc.getText('body').insert(0, 'kept');

        // A local mount given an s3Config has new storage too.
        await home.updateMount(mount.id, { s3Config: bucketB });

        expect(home.closing).toBe(true);
        expect(home.drive.hasCollabDocument(mount.id, created.id)).toBe(false);
        const reopened = await (await getTeamHome(ownerId)).drive.getCollabDocument(mount.id, created.id);
        expect(reopened.doc.getText('body').toString()).toBe('kept');
    });

    // Saved through the closed home, the file named the new bucket while the next home kept writing to the old one.
    test('a save whose bucket check outlasts its home is refused, and the next home keeps its settings', async () => {
        const check = await okS3Check();
        try {
            const { ownerId, home } = await newTeam();
            const mount = await home.addMount({ name: 'Raced', storageType: 's3', s3Config: bucketA });
            const { promise: checked, resolve: answerCheck } = Promise.withResolvers<void>();
            check.mockImplementationOnce(async () => {
                await checked;
                return { ok: true, message: 'Connection successful', versioning: 'enabled' };
            });

            const saving = home.updateMount(mount.id, { s3Config: bucketB });
            await home.close();
            const next = await getTeamHome(ownerId);
            const settingsFile = join(next.homeDir, PATHS.SETTINGS);
            const before = readFileSync(settingsFile, 'utf8');
            answerCheck();

            await expect(saving).rejects.toMatchObject({ status: 503, message: 'Home is closing' });
            expect(readFileSync(settingsFile, 'utf8')).toBe(before);
            expect(next.closing).toBe(false);
            expect(next.drive.getMountConfig(mount.id).s3Config).toEqual(bucketA);
        } finally {
            check.mockRestore();
        }
    });

    // Saved first, the mount stayed in the settings behind the 503, and the admin's retry added a second one.
    test('a new mount the closing home refuses is not saved', async () => {
        const { home } = await newTeam();
        const closing = home.close();

        await expect(home.addMount({ name: 'Refused', storageType: 'local' })).rejects.toMatchObject({
            status: 503,
            message: 'Home is closing',
        });
        await closing;
        expect(home.settings.get().mounts ?? {}).toEqual({});
    });
});
