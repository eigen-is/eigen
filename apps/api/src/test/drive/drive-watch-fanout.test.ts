import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getServerConfig } from '../../lib/config/server-config';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    drivePut,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

async function uploadFile(token: string, ownerId: string, mountId: string, name: string): Promise<DrivePath> {
    const root = await driveGet(token, ownerId, mountId, 'root');
    const file = new File([`content of ${name}`], name, { type: 'text/plain' });
    return driveUpload(token, ownerId, mountId, root.id, file);
}

function watch(token: string, ownerId: string, mountId: string, pathId: string): Promise<Response> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/path/${pathId}/watch`, { method: 'POST' });
}

function watchesList(token: string, ownerId: string, all: boolean): Promise<Response> {
    return authedRequest(token, `/drive/${ownerId}/watches${all ? '?all=1' : ''}`);
}

describe('Watched aggregate with team + shared fan-out', () => {
    let ctx: TestCtx;
    let team1Owner: string;
    let bobPersonalWatch: DrivePath; // bob watches a file in his own home
    let teamWatch: DrivePath; // bob watches a file in a team he belongs to
    let sharedWatch: DrivePath; // bob watches a file another user shared with him

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // team1: alice + bob.
        const team1Id = await createTeam(ctx, orgId, 'Watch Fanout Team 1');
        team1Owner = teamOwnerId(team1Id);
        await addMember(ctx, team1Id, ctx.alice.user.id);
        await addMember(ctx, team1Id, ctx.bob.user.id);
        await addTeamMount(ctx, team1Id, 'Team 1 Drive');

        const team1MountId = await firstMountId(ctx.alice.user.sessionToken, team1Owner);
        const bobMountId = await firstMountId(ctx.bob.user.sessionToken, ctx.bob.user.id);
        const aliceMountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);

        // 1) Personal: bob watches his own file.
        bobPersonalWatch = await uploadFile(ctx.bob.user.sessionToken, ctx.bob.user.id, bobMountId, 'bob-personal.txt');
        expect((await watch(ctx.bob.user.sessionToken, ctx.bob.user.id, bobMountId, bobPersonalWatch.id)).status).toBe(
            200,
        );

        // 2) Team: alice uploads to team1, bob (member) watches it.
        teamWatch = await uploadFile(ctx.alice.user.sessionToken, team1Owner, team1MountId, 'team-file.txt');
        expect((await watch(ctx.bob.user.sessionToken, team1Owner, team1MountId, teamWatch.id)).status).toBe(200);

        // 3) Shared: alice shares a personal file with bob, bob watches it.
        sharedWatch = await uploadFile(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            'alice-shared.txt',
        );
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${sharedWatch.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
            visibility: 'private',
        });
        expect((await watch(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, sharedWatch.id)).status).toBe(
            200,
        );
    });

    test('?all=1 returns personal + team + shared watches, each exactly once', async () => {
        const items = await assertJson<DrivePath[]>(
            await watchesList(ctx.bob.user.sessionToken, ctx.bob.user.id, true),
        );
        const ids = items.map((p) => p.id);
        expect(ids.filter((id) => id === bobPersonalWatch.id).length).toBe(1);
        expect(ids.filter((id) => id === teamWatch.id).length).toBe(1);
        expect(ids.filter((id) => id === sharedWatch.id).length).toBe(1);
        // No duplicate ids anywhere in the merged list.
        expect(new Set(ids).size).toBe(ids.length);
    });

    test("another member's ?all=1 shows only their own watches", async () => {
        // Alice never watched any of these three; her aggregate must exclude all of them.
        const items = await assertJson<DrivePath[]>(
            await watchesList(ctx.alice.user.sessionToken, ctx.alice.user.id, true),
        );
        const ids = new Set(items.map((p) => p.id));
        expect(ids.has(bobPersonalWatch.id)).toBe(false);
        expect(ids.has(teamWatch.id)).toBe(false);
        expect(ids.has(sharedWatch.id)).toBe(false);
    });

    test('non-self ownerId with ?all=1 is forbidden (403)', async () => {
        const res = await watchesList(ctx.bob.user.sessionToken, ctx.alice.user.id, true);
        expect(res.status).toBe(403);
    });

    test('no all param returns only the addressed home (unchanged per-owner behavior)', async () => {
        // bob's own home holds only bobPersonalWatch; the team + shared watch rows live in other homes.
        const items = await assertJson<DrivePath[]>(
            await watchesList(ctx.bob.user.sessionToken, ctx.bob.user.id, false),
        );
        const ids = new Set(items.map((p) => p.id));
        expect(ids.has(bobPersonalWatch.id)).toBe(true);
        expect(ids.has(teamWatch.id)).toBe(false);
        expect(ids.has(sharedWatch.id)).toBe(false);
    });
});
