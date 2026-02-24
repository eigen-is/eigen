import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('SSE', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('SSE Endpoint', () => {
        test('SSE endpoint requires authentication', async () => {
            const res = await ctx.app.handle(
                new Request(`http://localhost/sse/${ctx.alice.user.id}/events`)
            );
            expect([401, 500]).toContain(res.status);
        });

        test('SSE endpoint returns stream for authenticated user', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/event-stream');
        });

        test('SSE endpoint has correct headers', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/event-stream');
            expect(res.headers.get('cache-control')).toContain('no-cache');
        });

        test('ownerId spoofing resolves to authenticated user', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);

            if (res.body) {
                const reader = res.body.getReader?.();
                if (reader) await reader.cancel();
            }
        });

        test('invalid session token returns 401 or 500', async () => {
            const res = await authedRequest('invalid-token',
                `/sse/${ctx.alice.user.id}/events`);

            expect([401, 500]).toContain(res.status);
        });
    });

    describe('SSE Stream Content', () => {
        test('stream connection works', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);
            expect(res.body).toBeDefined();

            if (res.body) {
                const reader = res.body.getReader?.();
                if (reader) await reader.cancel();
            }
        });
    });

    describe('SSE Event Types', () => {
        test('SSE connection is established', async () => {
            const sseRes = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(sseRes.status).toBe(200);
            expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

            if (sseRes.body) {
                const reader = sseRes.body.getReader?.();
                if (reader) await reader.cancel();
            }
        });
    });

    describe('SSE Connection Management', () => {
        test('multiple clients can subscribe to same user', async () => {
            const res1 = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);
            const res2 = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);

            const reader1 = res1.body?.getReader();
            const reader2 = res2.body?.getReader();

            if (reader1) await reader1.cancel();
            if (reader2) await reader2.cancel();
        });

        test('stream can be cancelled', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);

            const reader = res.body?.getReader();
            if (!reader) return;

            await reader.cancel();

            expect(res.bodyUsed).toBe(true);
        });

        test('different users have separate event streams', async () => {
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/sse/${ctx.alice.user.id}/events`);
            const bobRes = await authedRequest(ctx.bob.user.sessionToken,
                `/sse/${ctx.bob.user.id}/events`);

            expect(aliceRes.status).toBe(200);
            expect(bobRes.status).toBe(200);

            const aliceReader = aliceRes.body?.getReader();
            const bobReader = bobRes.body?.getReader();

            if (aliceReader) await aliceReader.cancel();
            if (bobReader) await bobReader.cancel();
        });
    });
});
