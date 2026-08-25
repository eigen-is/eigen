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

// A distinctive mime so the aggregate list only ever contains this test's files, regardless of
// what other suites uploaded. `.replace('-', '/')` in the route swaps the FIRST hyphen only.
const FANOUT_MIME = 'application/x-eigen-fanout';
const MIME_SEGMENT = 'application-x-eigen-fanout';

async function uploadFanout(token: string, ownerId: string, mountId: string, name: string): Promise<DrivePath> {
    const root = await driveGet(token, ownerId, mountId, 'root');
    const file = new File([`content of ${name}`], name, { type: FANOUT_MIME });
    return driveUpload(token, ownerId, mountId, root.id, file);
}

function mimeList(token: string, ownerId: string, withTeams: boolean): Promise<Response> {
    return authedRequest(token, `/drive/${ownerId}/mime/${MIME_SEGMENT}${withTeams ? '?teams=1' : ''}`);
}

describe('Aggregate mime endpoint with team fan-out', () => {
    let ctx: TestCtx;
    let team1Id: string;
    let team1Owner: string;
    let team1MountId: string;
    let team1Doc: DrivePath;
    let team2Doc: DrivePath;
    let alicePersonalDoc: DrivePath;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // team1: alice + bob; team2: alice only (bob must never see team2 content).
        team1Id = await createTeam(ctx, orgId, 'Fanout Team 1');
        const team2Id = await createTeam(ctx, orgId, 'Fanout Team 2');
        team1Owner = teamOwnerId(team1Id);
        const team2Owner = teamOwnerId(team2Id);

        await addMember(ctx, team1Id, ctx.alice.user.id);
        await addMember(ctx, team1Id, ctx.bob.user.id);
        await addMember(ctx, team2Id, ctx.alice.user.id);

        await addTeamMount(ctx, team1Id, 'Team 1 Drive');
        await addTeamMount(ctx, team2Id, 'Team 2 Drive');

        team1MountId = await firstMountId(ctx.alice.user.sessionToken, team1Owner);
        const team2MountId = await firstMountId(ctx.alice.user.sessionToken, team2Owner);
        const aliceMountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);

        // One fanout-mime doc per drive.
        alicePersonalDoc = await uploadFanout(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            'alice.bin',
        );
        team1Doc = await uploadFanout(ctx.alice.user.sessionToken, team1Owner, team1MountId, 'team1-doc.bin');
        team2Doc = await uploadFanout(ctx.alice.user.sessionToken, team2Owner, team2MountId, 'team2-doc.bin');
    });

    test('member sees personal + all their team docs mixed via ?teams=1', async () => {
        const items = await assertJson<DrivePath[]>(
            await mimeList(ctx.alice.user.sessionToken, ctx.alice.user.id, true),
        );
        const ids = new Set(items.map((p) => p.id));
        expect(ids.has(alicePersonalDoc.id)).toBe(true);
        expect(ids.has(team1Doc.id)).toBe(true);
        expect(ids.has(team2Doc.id)).toBe(true);
    });

    test('aggregate is sorted by updatedAt DESC and has no duplicate ids', async () => {
        const items = await assertJson<DrivePath[]>(
            await mimeList(ctx.alice.user.sessionToken, ctx.alice.user.id, true),
        );
        const times = items.map((p) => new Date(p.updatedAt).getTime());
        for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        expect(new Set(items.map((p) => p.id)).size).toBe(items.length);
    });

    test('no teams param returns personal only (team docs excluded)', async () => {
        const items = await assertJson<DrivePath[]>(
            await mimeList(ctx.alice.user.sessionToken, ctx.alice.user.id, false),
        );
        const ids = new Set(items.map((p) => p.id));
        expect(ids.has(alicePersonalDoc.id)).toBe(true);
        expect(ids.has(team1Doc.id)).toBe(false);
        expect(ids.has(team2Doc.id)).toBe(false);
    });

    test('content of a team the caller is not a member of never appears', async () => {
        // Bob is in team1 only: team1-doc shows, team2-doc never does, alice's personal doc never does.
        const items = await assertJson<DrivePath[]>(await mimeList(ctx.bob.user.sessionToken, ctx.bob.user.id, true));
        const ids = new Set(items.map((p) => p.id));
        expect(ids.has(team1Doc.id)).toBe(true);
        expect(ids.has(team2Doc.id)).toBe(false);
        expect(ids.has(alicePersonalDoc.id)).toBe(false);
    });

    test('non-self ownerId with ?teams=1 is forbidden (403)', async () => {
        const res = await mimeList(ctx.bob.user.sessionToken, ctx.alice.user.id, true);
        expect(res.status).toBe(403);
    });

    test('a team owner is served without teams but rejected with ?teams=1 (self-only gate)', async () => {
        // The per-team mime view (no teams param) still serves a member cross-owner — byte-identical to
        // today. Aggregation (?teams=1) is strictly self-only, so the same team owner id is a 403.
        const served = await mimeList(ctx.bob.user.sessionToken, team1Owner, false);
        expect(served.status).toBe(200);
        const items = await assertJson<DrivePath[]>(served);
        expect(items.some((p) => p.id === team1Doc.id)).toBe(true);

        const aggregated = await mimeList(ctx.bob.user.sessionToken, team1Owner, true);
        expect(aggregated.status).toBe(403);
    });

    test('dedupe by path.id: authoritative team copy wins over a shared_paths mirror', async () => {
        // Share a team1 doc individually with bob → creates a shared_paths mirror in bob's personal
        // home (same path.id, hash null). Bob's ?teams=1 must return it exactly once, and the surviving
        // copy must be the authoritative team copy (non-null hash), not the mirror.
        const dedupeDoc = await uploadFanout(ctx.alice.user.sessionToken, team1Owner, team1MountId, 'dedupe-doc.bin');
        await drivePut(ctx.alice.user.sessionToken, team1Owner, team1MountId, `path/${dedupeDoc.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
            visibility: 'private',
        });

        // Precondition: the mirror is now visible in bob's personal (no-teams) view.
        const personal = await assertJson<DrivePath[]>(
            await mimeList(ctx.bob.user.sessionToken, ctx.bob.user.id, false),
        );
        expect(personal.some((p) => p.id === dedupeDoc.id)).toBe(true);

        const items = await assertJson<DrivePath[]>(await mimeList(ctx.bob.user.sessionToken, ctx.bob.user.id, true));
        const matches = items.filter((p) => p.id === dedupeDoc.id);
        expect(matches.length).toBe(1);
        expect(matches[0].hash).not.toBeNull();
    });
});
