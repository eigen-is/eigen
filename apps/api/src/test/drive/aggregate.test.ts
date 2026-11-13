import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { getPublicConfig } from '../../lib/config/server-config';
import { aggregateFileSearch, aggregateMimeContents, aggregateWatches } from '../../lib/drive/aggregate';
import { getSharedDatabase } from '../../lib/drive/shared';
import { sharedPaths } from '../../lib/drive/shared-schema';
import { clearHomeRestoring, getHome, markHomeRestoring } from '../../lib/home/get-home';
import type { User } from '../../lib/user';
import { getUserById } from '../../lib/user';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    createTestUser,
    driveGet,
    drivePut,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// A distinctive type and name, so these lists hold only this file's uploads.
const MIME = 'application/x-eigen-aggregate';
const NAME_TOKEN = 'quillaggregatetoken';

describe('Reads across homes', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let caller: User;
    let personalFile: DrivePath;
    let liveTeamFile: DrivePath;
    let brokenTeamFile: DrivePath;
    let brokenTeam: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getPublicConfig().orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        caller = await asUser(ctx.alice.user);
        const liveTeam = await newTeam(orgId);
        brokenTeam = await newTeam(orgId);

        personalFile = await upload(caller.id, 'personal');
        liveTeamFile = await upload(liveTeam, 'live-team');
        brokenTeamFile = await upload(brokenTeam, 'broken-team');
        for (const path of [personalFile, liveTeamFile, brokenTeamFile]) {
            const res = await watch(ctx.alice.user.sessionToken, path);
            expect(res.status).toBe(200);
        }
    });

    afterEach(() => mock.restore());

    async function asUser(testUser: TestUser): Promise<User> {
        const user = await getUserById(testUser.id);
        if (!user) throw new Error(`No user row for ${testUser.email}`);
        return user;
    }

    async function newTeam(orgId: string): Promise<string> {
        const teamId = await createTeam(ctx, orgId, `Team ${crypto.randomUUID()}`);
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addTeamMount(ctx, teamId, 'Drive');
        return teamOwnerId(teamId);
    }

    async function upload(ownerId: string, label: string, token = ctx.alice.user.sessionToken): Promise<DrivePath> {
        const mountId = await firstMountId(token, ownerId);
        const root = await driveGet(token, ownerId, mountId, 'root');
        const file = new File(['content'], `${NAME_TOKEN}-${label}.bin`, { type: MIME });
        return driveUpload(token, ownerId, mountId, root.id, file);
    }

    function watch(token: string, path: DrivePath): Promise<Response> {
        return authedRequest(token, `/drive/${path.ownerId}/${path.mountId}/path/${path.id}/watch`, {
            method: 'POST',
        });
    }

    // A home under restore refuses every getHome, the same refusal a live server gives.
    async function whileRestoring(ownerId: string, read: () => Promise<DrivePath[]>): Promise<DrivePath[]> {
        markHomeRestoring(ownerId);
        try {
            return await read();
        } finally {
            clearHomeRestoring(ownerId);
        }
    }

    function expectOnlyBrokenTeamMissing(paths: DrivePath[]): void {
        const ids = paths.map((path) => path.id);
        expect(ids).toEqual(expect.arrayContaining([personalFile.id, liveTeamFile.id]));
        expect(ids).not.toContain(brokenTeamFile.id);
    }

    test('every home answers with no error logged', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const ids = (await aggregateMimeContents(caller, MIME)).map((path) => path.id);
        expect(ids).toEqual(expect.arrayContaining([personalFile.id, liveTeamFile.id, brokenTeamFile.id]));
        expect(errors).not.toHaveBeenCalled();
    });

    test('All docs logs a failed read and still returns the other homes', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const paths = await whileRestoring(brokenTeam, () => aggregateMimeContents(caller, MIME));
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(brokenTeam), expect.anything());
        expectOnlyBrokenTeamMissing(paths);
    });

    test('file search logs a failed read and still returns the other homes', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const paths = await whileRestoring(brokenTeam, () => aggregateFileSearch(caller, NAME_TOKEN, 20));
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(brokenTeam), expect.anything());
        expectOnlyBrokenTeamMissing(paths);
    });

    test('Watched logs a failed read and still returns the other homes', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const paths = await whileRestoring(brokenTeam, () => aggregateWatches(caller));
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(brokenTeam), expect.anything());
        expectOnlyBrokenTeamMissing(paths);
    });

    test('Watched skips a deleted owner still in shared_paths, with no error logged', async () => {
        const { alice, bob } = ctx;
        const owner = await createTestUser(`owner-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Owner');
        await getHome(owner.id);
        const shared = await upload(owner.id, 'shared', owner.sessionToken);
        await drivePut(owner.sessionToken, owner.id, shared.mountId, `path/${shared.id}/acl`, {
            add: [{ id: bob.user.email, read: true, write: false }],
        });
        const sharedDb = await getSharedDatabase(await getHome(bob.user.id));
        const mirrorRows = () => sharedDb.select().from(sharedPaths).where(eq(sharedPaths.ownerId, owner.id)).all();
        await eventually(async () => (mirrorRows().length > 0 ? true : undefined), 'the row');
        expect((await watch(bob.user.sessionToken, shared)).status).toBe(200);
        const own = await upload(bob.user.id, 'own', bob.user.sessionToken);
        expect((await watch(bob.user.sessionToken, own)).status).toBe(200);

        const deleted = await authedRequest(alice.user.sessionToken, `/settings/user/${owner.id}`, {
            method: 'DELETE',
        });
        expect(deleted.status).toBe(200);
        expect(mirrorRows()).toHaveLength(1);

        const bobUser = await asUser(bob.user);
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const ids = (await aggregateWatches(bobUser)).map((path) => path.id);
        expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes(owner.id)))).toBe(false);
        expect(ids).toContain(own.id);
        expect(ids).not.toContain(shared.id);
    });
});
