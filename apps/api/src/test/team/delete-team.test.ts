import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DrivePath } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { waitForHomeSlot } from '../../lib/backup/jobs';
import { getTeamDataPath } from '../../lib/config/paths';
import { getPublicConfig } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { evictHome, getTeamHome } from '../../lib/home/get-home';
import { getEigenDb } from '../../lib/share/db';
import { addRegistryEntry, getEntriesForTarget } from '../../lib/share/registry';
import { shareRegistry } from '../../lib/share/schema';
import { LocalStorage } from '../../lib/storage/local-storage';
import { getTeamExists } from '../../lib/team';
import { FakeS3Server } from '../fake-s3-server';
import {
    addMember,
    assertJson,
    authedRequest,
    createTeam,
    driveUpload,
    eventually,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

describe('Delete team', () => {
    const backing = join(TEST_DATA_DIR, 'delete-team-s3-backing');
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let orgId: string;
    let fake: FakeS3Server;

    beforeAll(async () => {
        ctx = await getTestContext();
        orgId = getPublicConfig().orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        fake = new FakeS3Server(new LocalStorage(backing));
        await updateServerSettings({ defaults: { mount: { s3Config: await fake.start() } } });
    });

    afterAll(async () => {
        await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });
        await fake.stop();
        rmSync(backing, { recursive: true, force: true });
    });

    function removeTeam(teamId: string): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, organizationId: orgId }),
        });
    }

    // A team with a local drive and a bucket drive, one photo on each; answers the bucket's object keys.
    async function teamWithFiles(name: string): Promise<{ teamId: string; keys: string[] }> {
        const teamId = await createTeam(ctx, orgId, name);
        await addMember(ctx, teamId, ctx.alice.user.id);
        const ownerId = teamOwnerId(teamId);
        const home = await getTeamHome(ownerId);
        const local = await home.addMount({ name: 'Local', storageType: 'local' });
        const bucket = await home.addMount({ name: 'Bucket', storageType: 's3' });
        for (const mountId of [local.id, bucket.id]) {
            const root = await assertJson<DrivePath>(
                await authedRequest(ctx.alice.user.sessionToken, `/drive/${ownerId}/${mountId}/root`),
            );
            const file = new File([TEST_PNG_BYTES], 'photo.png', { type: 'image/png' });
            await driveUpload(ctx.alice.user.sessionToken, ownerId, mountId, root.id, file);
        }
        await evictHome(ownerId);
        const db = openMountMetadata(join(getTeamDataPath(teamId), 'mounts', bucket.id, 'metadata.db'));
        try {
            const keys = db
                .query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'")
                .all()
                .map((row) => row.file);
            expect(keys).toHaveLength(1);
            for (const key of keys) expect(await fake.store.exists(key)).toBe(true);
            return { teamId, keys };
        } finally {
            db.close();
        }
    }

    test("deleting a team removes its folder, its safety copies, its bucket objects and its share rows, and leaves another team's", async () => {
        const doomed = await teamWithFiles('Doomed Team');
        const kept = await teamWithFiles('Kept Team');
        const teamDir = getTeamDataPath(doomed.teamId);
        const preRestore = `${teamDir}${PRE_RESTORE_SUFFIX}20200101-000000`;
        cpSync(teamDir, preRestore, { recursive: true });
        const ownerId = teamOwnerId(doomed.teamId);
        await addRegistryEntry(ownerId, 'someone@example.com');
        await addRegistryEntry(ctx.alice.user.id, ownerId);

        const res = await removeTeam(doomed.teamId);
        expect(res.status).toBe(200);
        expect(await getTeamExists(doomed.teamId)).toBe(false);
        expect(existsSync(teamDir)).toBe(false);
        expect(existsSync(preRestore)).toBe(false);
        await eventually(
            async () => ((await fake.store.exists(doomed.keys[0])) ? undefined : true),
            'the bucket delete',
        );
        const eigenDb = await getEigenDb();
        expect(eigenDb.select().from(shareRegistry).where(eq(shareRegistry.fromUserId, ownerId)).all()).toHaveLength(0);
        expect(await getEntriesForTarget(ownerId)).toHaveLength(0);

        expect(existsSync(getTeamDataPath(kept.teamId))).toBe(true);
        expect(await fake.store.exists(kept.keys[0])).toBe(true);
        expect((await removeTeam(kept.teamId)).status).toBe(200);
    });

    test("a deletion while the team's home slot is held answers 409 and keeps the team and its files", async () => {
        const { teamId, keys } = await teamWithFiles('Busy Team');
        const release = await waitForHomeSlot(teamOwnerId(teamId), 'restore');
        try {
            expect((await removeTeam(teamId)).status).toBe(409);
            expect(await getTeamExists(teamId)).toBe(true);
            expect(existsSync(getTeamDataPath(teamId))).toBe(true);
            expect(await fake.store.exists(keys[0])).toBe(true);
        } finally {
            release();
        }
        expect((await removeTeam(teamId)).status).toBe(200);
        expect(existsSync(getTeamDataPath(teamId))).toBe(false);
    });
});
