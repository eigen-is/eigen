import { beforeAll, describe, expect, test } from 'bun:test';
import { authedRequest, getTestContext } from './setup';

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

    test('authenticated request for unknown drive owner returns 404', async () => {
        const response = await authedRequest(ctx.alice.user.sessionToken, '/drive/non-existent-owner/mounts');

        expect(response.status).toBe(404);
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
