import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../lib/config/server-config';
import { addMember, authedRequest, createTeam, getTestContext, TEST_PNG_BYTES } from './setup';

function avatarForm(): FormData {
    const form = new FormData();
    form.append('file', new File([TEST_PNG_BYTES], 'team-avatar.png', { type: 'image/png' }));
    return form;
}

describe('Team Avatar', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        teamId = await createTeam(ctx, orgId, 'Avatar Team');
        // Bob is a plain member; Charlie is a non-member.
        await addMember(ctx, teamId, ctx.bob.user.id);
    });

    test('org admin uploads avatar, then /p/avatar/team_{id} returns WebP', async () => {
        const uploadRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        expect(uploadRes.status).toBe(200);

        const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${teamOwnerId(teamId)}`));
        expect(avatarRes.status).toBe(200);
        expect(avatarRes.headers.get('Content-Type')).toBe('image/webp');
        expect((await avatarRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });

    test('plain team member cannot upload avatar', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        expect(res.status).toBe(403);
    });

    test('non-member cannot upload avatar', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        expect(res.status).toBe(403);
    });

    test('DELETE removes the avatar, /p/avatar/team_{id} falls back to SVG', async () => {
        const delRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'DELETE',
        });
        expect(delRes.status).toBe(200);

        const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${teamOwnerId(teamId)}`));
        expect(avatarRes.status).toBe(200);
        expect(avatarRes.headers.get('Content-Type')).toBe('image/svg+xml');
    });

    test('unknown team id falls back to SVG without a 500', async () => {
        const avatarRes = await ctx.app.handle(new Request('http://localhost/p/avatar/team_does-not-exist'));
        expect(avatarRes.status).toBe(200);
        expect(avatarRes.headers.get('Content-Type')).toBe('image/svg+xml');
    });

    test('org admin uploading to a nonexistent team id gets 404 (no orphan file written)', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId('does-not-exist')}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        expect(res.status).toBe(404);
    });

    test('org admin deleting the avatar of a nonexistent team gets 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId('does-not-exist')}/avatar`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(404);
    });

    // Replacing an avatar must be visible immediately: the routes return a fresh, unique
    // avatar URL per mutation (the contacts pattern — a changed URL can never hit a stale
    // browser-cache entry), and serving revalidates via ETag so plain-URL surfaces recover
    // on reload instead of showing a 24h-stale image.
    test('upload and remove return a fresh avatar URL, unique per call', async () => {
        const prefix = `p/avatar/${teamOwnerId(teamId)}?v=`;

        const first = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        expect(first.status).toBe(200);
        const firstUrl = await first.text();
        expect(firstUrl.startsWith(prefix)).toBe(true);

        const second = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        const secondUrl = await second.text();
        expect(secondUrl.startsWith(prefix)).toBe(true);
        expect(secondUrl).not.toBe(firstUrl);

        const removed = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'DELETE',
        });
        const removedUrl = await removed.text();
        expect(removedUrl.startsWith(prefix)).toBe(true);
        expect(removedUrl).not.toBe(secondUrl);
    });

    test('team avatar serving revalidates: ETag + no-cache, 304 on match, new ETag after replace', async () => {
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });

        const url = `http://localhost/p/avatar/${teamOwnerId(teamId)}`;
        const res = await ctx.app.handle(new Request(url));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toContain('no-cache');
        const etag = res.headers.get('ETag');
        expect(etag).toBeTruthy();

        const cached = await ctx.app.handle(new Request(url, { headers: { 'If-None-Match': etag! } }));
        expect(cached.status).toBe(304);

        await Bun.sleep(2);
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/avatar`, {
            method: 'POST',
            body: avatarForm(),
        });
        const fresh = await ctx.app.handle(new Request(url, { headers: { 'If-None-Match': etag! } }));
        expect(fresh.status).toBe(200);
        expect(fresh.headers.get('ETag')).not.toBe(etag);
    });
});
