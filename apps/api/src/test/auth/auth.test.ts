import { beforeAll, describe, expect, test } from 'bun:test';
import { authedRequest, getTestContext } from '../setup';

describe('Auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('health check returns OK', async () => {
        const response = await ctx.app.handle(new Request('http://localhost/health'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('OK');
    });

    test('root returns welcome message', async () => {
        const response = await ctx.app.handle(new Request('http://localhost/'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('eigen|api>');
    });

    test('unauthenticated request to protected route fails', async () => {
        const response = await ctx.app.handle(new Request(`http://localhost/drive/${ctx.alice.user.id}/mounts`));
        expect(response.status).not.toBe(200);
    });

    test('invalid session token cannot access protected route', async () => {
        const response = await ctx.app.handle(
            new Request(`http://localhost/drive/${ctx.alice.user.id}/mounts`, {
                headers: {
                    cookie: 'better-auth.session_token=invalid-token',
                },
            }),
        );
        expect(response.status).not.toBe(200);
    });

    test('authenticated request for a malformed drive owner returns 400', async () => {
        // 'non-existent-owner' isn't a valid ownerId shape (not a 32-char id / team_/org_ prefix),
        // so parseOwnerId flags it invalid and the route rejects the bad request (was a 404 before
        // the audit finding-26 fix, which made a malformed id a 400 instead of a not-found).
        const response = await authedRequest(ctx.alice.user.sessionToken, '/drive/non-existent-owner/mounts');

        expect(response.status).toBe(400);
    });

    test('authenticated request for a well-formed but unowned drive owner is not a 400', async () => {
        // A valid-shaped id Alice doesn't own passes parseOwnerId (so no 400) and is rejected by the
        // access/existence check instead — confirms finding-26's 400 only catches malformed ids.
        const response = await authedRequest(
            ctx.alice.user.sessionToken,
            '/drive/00000000000000000000000000000000/mounts',
        );

        expect([403, 404]).toContain(response.status);
    });

    test('Alice can access authenticated routes', async () => {
        const { data, error } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        expect(error).toBeNull();
        expect(data).toBeDefined();
    });

    test('Bob can access authenticated routes', async () => {
        const { data, error } = await ctx.bob.api.drive({ ownerId: ctx.bob.user.id }).mounts.get();
        expect(error).toBeNull();
        expect(data).toBeDefined();
    });

    test('Alice and Bob are different users', () => {
        expect(ctx.alice.user.id).not.toBe(ctx.bob.user.id);
        expect(ctx.alice.user.email).not.toBe(ctx.bob.user.email);
    });
});
