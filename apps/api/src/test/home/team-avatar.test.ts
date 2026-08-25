import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../../lib/config/server-config';
import { addMember, authedRequest, createTeam, getTestContext, TEST_PNG_BYTES } from '../setup';

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
});
