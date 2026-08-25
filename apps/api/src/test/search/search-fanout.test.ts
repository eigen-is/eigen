import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { SearchResponse } from '@workspace/lib/types/search';
import { getServerConfig } from '../../lib/config/server-config';
import {
    addMember,
    addTeamMount,
    app,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const isWindows = process.platform === 'win32';

// Upload a plaintext file with a distinctive name AND body — plaintext bodies get contentDirty at
// upload, so a content reindex sweep on the owning home makes the body FTS-searchable.
async function uploadText(
    token: string,
    ownerId: string,
    mountId: string,
    name: string,
    body: string,
): Promise<DrivePath> {
    const root = await driveGet(token, ownerId, mountId, 'root');
    const file = new File([new TextEncoder().encode(body)], name, { type: 'text/plain' });
    return driveUpload(token, ownerId, mountId, root.id, file);
}

function searchFiles(
    token: string,
    ownerId: string,
    q: string,
    opts: { teams?: boolean; limit?: number } = {},
): Promise<Response> {
    const params = new URLSearchParams({ q, sources: 'file' });
    if (opts.teams) params.set('teams', '1');
    if (opts.limit) params.set('limit', String(opts.limit));
    return authedRequest(token, `/search/${ownerId}?${params.toString()}`);
}

describe('Search team fan-out', () => {
    let ctx: TestCtx;
    let team1Owner: string;
    let team2Owner: string;
    let aliceMountId: string;
    let team1MountId: string;
    let team2MountId: string;
    let team1File: DrivePath;
    let team2File: DrivePath;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // team1: alice + bob; team2: alice only (bob must never see team2 content).
        const team1Id = await createTeam(ctx, orgId, 'Search Fanout Team 1');
        const team2Id = await createTeam(ctx, orgId, 'Search Fanout Team 2');
        team1Owner = teamOwnerId(team1Id);
        team2Owner = teamOwnerId(team2Id);

        await addMember(ctx, team1Id, ctx.alice.user.id);
        await addMember(ctx, team1Id, ctx.bob.user.id);
        await addMember(ctx, team2Id, ctx.alice.user.id);

        await addTeamMount(ctx, team1Id, 'Search Team 1 Drive');
        await addTeamMount(ctx, team2Id, 'Search Team 2 Drive');

        team1MountId = await firstMountId(ctx.alice.user.sessionToken, team1Owner);
        team2MountId = await firstMountId(ctx.alice.user.sessionToken, team2Owner);
        aliceMountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);

        // team1 doc: name token `zephyrquux`, body token `wobblenaut`.
        team1File = await uploadText(
            ctx.alice.user.sessionToken,
            team1Owner,
            team1MountId,
            'zephyrquux-report.txt',
            'this file contains wobblenaut inside the body text',
        );
        // team2 doc: name token `plimsollcap`, body token `grimbold` (bob is not a member).
        team2File = await uploadText(
            ctx.alice.user.sessionToken,
            team2Owner,
            team2MountId,
            'plimsollcap-notes.txt',
            'this file contains grimbold inside the body text',
        );

        // Drain each team home's content reindex queue so the plaintext bodies become searchable.
        const { getHome } = await import('../../lib/home');
        await (await getHome(team1Owner)).drive.flushContentReindex();
        await (await getHome(team2Owner)).drive.flushContentReindex();
    });

    test('a member finds a team doc by NAME and by BODY content via ?teams=1', async () => {
        const byName = await assertJson<SearchResponse>(
            await searchFiles(ctx.alice.user.sessionToken, ctx.alice.user.id, 'zephyrquux', { teams: true }),
        );
        expect(byName.file.some((h) => h.id === team1File.id)).toBe(true);

        const byBody = await assertJson<SearchResponse>(
            await searchFiles(ctx.alice.user.sessionToken, ctx.alice.user.id, 'wobblenaut', { teams: true }),
        );
        expect(byBody.file.some((h) => h.id === team1File.id)).toBe(true);
    });

    test('team content is not returned without the ?teams param', async () => {
        const byName = await assertJson<SearchResponse>(
            await searchFiles(ctx.alice.user.sessionToken, ctx.alice.user.id, 'zephyrquux'),
        );
        expect(byName.file.some((h) => h.id === team1File.id)).toBe(false);

        const byBody = await assertJson<SearchResponse>(
            await searchFiles(ctx.alice.user.sessionToken, ctx.alice.user.id, 'wobblenaut'),
        );
        expect(byBody.file.some((h) => h.id === team1File.id)).toBe(false);
    });

    test('a non-member never sees another team’s content via ?teams=1', async () => {
        // Bob is in team1 only: he sees team1's doc but never team2's (by name or by body).
        const team1Hit = await assertJson<SearchResponse>(
            await searchFiles(ctx.bob.user.sessionToken, ctx.bob.user.id, 'zephyrquux', { teams: true }),
        );
        expect(team1Hit.file.some((h) => h.id === team1File.id)).toBe(true);

        const team2ByName = await assertJson<SearchResponse>(
            await searchFiles(ctx.bob.user.sessionToken, ctx.bob.user.id, 'plimsollcap', { teams: true }),
        );
        expect(team2ByName.file.some((h) => h.id === team2File.id)).toBe(false);

        const team2ByBody = await assertJson<SearchResponse>(
            await searchFiles(ctx.bob.user.sessionToken, ctx.bob.user.id, 'grimbold', { teams: true }),
        );
        expect(team2ByBody.file.some((h) => h.id === team2File.id)).toBe(false);
    });

    test('searching another user’s ownerId with ?teams=1 is rejected with 403', async () => {
        const res = await searchFiles(ctx.bob.user.sessionToken, ctx.alice.user.id, 'zephyrquux', { teams: true });
        expect(res.status).toBe(403);
    });

    test('the combined result respects the requested limit', async () => {
        // Three files sharing one token across personal + both teams; a limit of 2 must trim the merge.
        const token = 'quaxlimittoken';
        await uploadText(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `${token}-a.txt`, 'body');
        await uploadText(ctx.alice.user.sessionToken, team1Owner, team1MountId, `${token}-b.txt`, 'body');
        await uploadText(ctx.alice.user.sessionToken, team2Owner, team2MountId, `${token}-c.txt`, 'body');

        const data = await assertJson<SearchResponse>(
            await searchFiles(ctx.alice.user.sessionToken, ctx.alice.user.id, token, { teams: true, limit: 2 }),
        );
        expect(data.file.length).toBe(2);
    });

    // Mail delivery relies on the maildir filesystem watcher, which races on Windows (see search.test.ts).
    test.skipIf(isWindows)('mail results are unaffected by the ?teams param', async () => {
        const eml = [
            'From: sender@example.com',
            'To: alice@test.eigen.is',
            'Subject: Zaphodmail fanout probe',
            '',
            'body text',
        ].join('\r\n');
        const delivered = await app.handle(
            new Request('http://localhost/mail/deliver/alice@test.eigen.is', {
                method: 'POST',
                headers: { 'Content-Type': 'message/rfc822' },
                body: new TextEncoder().encode(eml).buffer,
            }),
        );
        expect(delivered.status).toBe(200);

        const { getHome } = await import('../../lib/home');
        for (let i = 0; i < 40; i++) {
            const home = await getHome(ctx.alice.user.id);
            await home.mail.mailboxGet('');
            if (home.mail.search({ q: 'zaphodmail', limit: 20 }).length >= 1) break;
            await Bun.sleep(25);
        }

        // Same query, default sources (mail + file), with and without the team fan-out.
        const withoutTeams = await assertJson<SearchResponse>(
            await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=zaphodmail`),
        );
        const withTeams = await assertJson<SearchResponse>(
            await authedRequest(ctx.alice.user.sessionToken, `/search/${ctx.alice.user.id}?q=zaphodmail&teams=1`),
        );
        expect(withoutTeams.mail.some((h) => h.subject === 'Zaphodmail fanout probe')).toBe(true);
        // The teams param touches only the file source — the mail array must be identical.
        expect(withTeams.mail).toEqual(withoutTeams.mail);
    });
});
