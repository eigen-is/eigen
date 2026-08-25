import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage } from '@workspace/lib/types';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import { assertJson, authedRequest, driveGet, drivePost, driveUpload, findOrFail, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Cross-Domain Integration', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        expect(mounts).toBeDefined();
        expect(mounts!.length).toBeGreaterThan(0);
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        expect(root).toBeDefined();
        aliceRootId = root.id;
    });

    describe('Drive and Chat Integration', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Integration Chat' },
            );
            chatId = chat.id;
        });

        test('chat file is accessible via drive API', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${chatId}`,
            );

            const data = await assertJson<DrivePath>(res);
            expect(data.type).toBe('chat');
        });

        test('chat has internal structure via drive API', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${chatId}`,
            );

            const data = await assertJson<DrivePath[]>(res);
            expect(Array.isArray(data)).toBe(true);

            findOrFail(data, (item) => item.name === 'data.db');
            findOrFail(data, (item) => item.name === 'media');
        });

        test('chat messages are accessible via chat API', async () => {
            const postRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Integration test message' }),
                },
            );
            expect(postRes.status).toBe(200);

            const getRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
            );

            const messages = await assertJson<ChatMessage[]>(getRes);
            expect(messages.some((m) => m.content === 'Integration test message')).toBe(true);
        });

        test('chat and drive permissions are synchronized', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: true }],
                    }),
                },
            );

            const drivePermRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/permissions`,
            );
            const drivePerm = await assertJson<{ canRead: boolean; canWrite: boolean }>(drivePermRes);
            expect(drivePerm.canRead).toBe(true);

            const chatPostRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Bob can write' }),
                },
            );
            expect(chatPostRes.status).toBe(200);
        });
    });

    describe('Public API', () => {
        test('public avatar is accessible', async () => {
            const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.alice.user.email}`));
            expect(avatarRes.status).toBe(200);
            expect(avatarRes.headers.get('content-type')).toMatch(/image\//);
        });

        test('public avatar fallback for unknown user returns SVG', async () => {
            const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/unknown@test.eigen.is`));
            expect(avatarRes.status).toBe(200);
            expect(avatarRes.headers.get('content-type')).toContain('image/svg+xml');
        });

        test('waitlist endpoint validates missing email', async () => {
            const res = await ctx.app.handle(
                new Request(`http://localhost/p/waitlist`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notes: 'test' }),
                }),
            );
            expect(res.status).toBe(422); // Elysia validation error
        });

        test('public user info returns 404 for unknown user', async () => {
            const res = await ctx.app.handle(new Request(`http://localhost/p/user/unknown@test.eigen.is`));
            expect(res.status).toBe(404);
        });
    });

    describe('Home and Drive Integration', () => {
        test('home size increases after drive upload', async () => {
            const { data: sizeBefore } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();
            const driveSizeBefore = sizeBefore!.drive.default.used;

            const file = new File(['test content for size'], 'size-test.txt', { type: 'text/plain' });
            await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, aliceRootId, file);

            const { data: sizeAfter } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();
            expect(sizeAfter!.drive.default.used).toBeGreaterThan(driveSizeBefore);
        });
    });

    describe('Collaboration Integration', () => {
        let docId: string;

        beforeAll(async () => {
            const doc = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'Collaboration Test' },
            );
            docId = doc.id;
        });

        test('document is accessible via collab API after drive creation', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`,
            );

            const data = await assertJson<CollabDocumentInfo>(res);
            expect(data.path).toBeDefined();
            expect(data.path!.id).toBe(docId);
        });

        test('collab permissions match drive permissions', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${docId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
                    }),
                },
            );

            const collabRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/collab/${ctx.alice.user.id}/${aliceMountId}/${docId}/info`,
            );
            const collabData = await assertJson<CollabDocumentInfo>(collabRes);

            expect(collabData.canRead).toBe(true);
            expect(collabData.canWrite).toBe(false);
        });
    });
});
