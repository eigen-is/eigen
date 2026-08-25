import { beforeAll, describe, expect, test } from 'bun:test';
import type { SSEventDrive } from '@workspace/lib/types/sse';
import { authedRequest, collectSSE, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('SSE', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('SSE Endpoint', () => {
        test('requires authentication', async () => {
            const res = await ctx.app.handle(new Request(`http://localhost/sse/${ctx.alice.user.id}/events`));
            expect([401, 500]).toContain(res.status);
        });

        test('invalid session token returns error', async () => {
            const res = await authedRequest('invalid-token', `/sse/${ctx.alice.user.id}/events`);
            expect([401, 500]).toContain(res.status);
        });

        test('returns event-stream with correct headers', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);
            // SSE streams use 200 but we manually check because assertJson would parse the body
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('text/event-stream');
            expect(res.headers.get('cache-control')).toContain('no-cache');
            expect(res.body).toBeDefined();

            if (res.body) {
                const reader = res.body.getReader?.();
                if (reader) await reader.cancel();
            }
        });

        test('ownerId spoofing is rejected with 403', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);
            expect(res.status).toBe(403);
        });
    });

    describe('SSE Connection Management', () => {
        test('multiple clients can subscribe to same user', async () => {
            const res1 = await authedRequest(ctx.alice.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);
            const res2 = await authedRequest(ctx.alice.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);

            const reader1 = res1.body?.getReader();
            const reader2 = res2.body?.getReader();

            if (reader1) await reader1.cancel();
            if (reader2) await reader2.cancel();
        });

        test('stream can be cancelled', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);

            expect(res.status).toBe(200);

            const reader = res.body?.getReader();
            if (!reader) return;

            await reader.cancel();

            expect(res.bodyUsed).toBe(true);
        });

        test('different users have separate event streams', async () => {
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken, `/sse/${ctx.alice.user.id}/events`);
            const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/sse/${ctx.bob.user.id}/events`);

            expect(aliceRes.status).toBe(200);
            expect(bobRes.status).toBe(200);

            const aliceReader = aliceRes.body?.getReader();
            const bobReader = bobRes.body?.getReader();

            if (aliceReader) await aliceReader.cancel();
            if (bobReader) await bobReader.cancel();
        });
    });

    describe('SSE ACL Events', () => {
        test('owner receives DRIVE_ACL_UPDATED when ACL is changed', async () => {
            // Create a folder to share
            const { data: root } = await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .root.get();
            const { data: folder } = await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .folder({ pathId: root!.id })
                .post({ folderName: 'sse-test-folder' });

            // Subscribe to Alice's SSE events
            const aliceSSE = collectSSE(ctx.alice.user.id);
            await new Promise((r) => setTimeout(r, 50));

            // Set ACL - share with Bob
            await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .path({ pathId: folder!.id })
                .acl.put({
                    add: [{ id: ctx.bob.user.email, read: true, write: false }],
                });

            await new Promise((r) => setTimeout(r, 50));
            aliceSSE.stop();

            const aclUpdated = aliceSSE.events.filter((e) => e.type === 'drive:acl-updated');
            expect(aclUpdated.length).toBeGreaterThanOrEqual(1);
            expect((aclUpdated[0] as SSEventDrive).path.id).toBe(folder!.id);
        });

        test('shared user receives DRIVE_ACL_UPDATED when ACL is modified on existing share', async () => {
            // Create a folder and share with Bob
            const { data: root } = await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .root.get();
            const { data: folder } = await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .folder({ pathId: root!.id })
                .post({ folderName: 'sse-shared-test' });

            await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .path({ pathId: folder!.id })
                .acl.put({
                    add: [{ id: ctx.bob.user.email, read: true, write: false }],
                });

            // Now subscribe to Bob's SSE events
            const bobSSE = collectSSE(ctx.bob.user.id);
            await new Promise((r) => setTimeout(r, 50));

            // Modify ACL — add Charlie (Bob already has share, so receiveSharedPathChange updates existing)
            await ctx.alice.api
                .drive({ ownerId: ctx.alice.user.id })({ mountId: 'default' })
                .path({ pathId: folder!.id })
                .acl.put({
                    add: [
                        { id: ctx.bob.user.email, read: true, write: true },
                        { id: ctx.charlie.user.email, read: true, write: false },
                    ],
                });

            await new Promise((r) => setTimeout(r, 50));
            bobSSE.stop();

            // Bob should receive DRIVE_ACL_UPDATED (not just SHARED/UNSHARED) since the path was already shared
            const aclUpdated = bobSSE.events.filter((e) => e.type === 'drive:acl-updated');
            expect(aclUpdated.length).toBeGreaterThanOrEqual(1);
        });
    });
});
