import { beforeAll, describe, expect, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileEvent } from '@workspace/lib/types/file-history';
import {
    assertJson,
    authedRequest,
    chatPost,
    driveGet,
    drivePost,
    drivePut,
    findOrFail,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Comment lifecycle via chat-create', () => {
    let ctx: TestCtx;
    let mountId: string;
    let docId: string;
    let docChatFolderId: string;
    let mountRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        mountRootId = root.id;

        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${mountRootId}/create/doc`,
            { fileName: 'chat-create-test' },
        );
        docId = doc.id;

        const docChildren = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docId}`,
        );
        docChatFolderId = findOrFail(docChildren, (c: DrivePath) => c.name === 'chat').id;
    });

    async function listComments(): Promise<CommentEntry[]> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments`,
        );
        return assertJson<CommentEntry[]>(res);
    }

    test('chat created under container/chat/ → comments.db row with createdBy', async () => {
        await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docChatFolderId}/create/chat`,
            { fileName: 'inside-container' },
        );

        const row = (await listComments()).find((r) => r.chatName === 'inside-container.eigenchat');
        expect(row).toBeDefined();
        expect(row!.createdBy).toBe(ctx.alice.user.email);
        expect(row!.status).toBe('open');
        expect(row!.messageCount).toBe(0);
    });

    test('chat created at mount root (no container) → no comments.db row created', async () => {
        await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${mountRootId}/create/chat`,
            { fileName: 'standalone' },
        );

        expect((await listComments()).find((r) => r.chatName === 'standalone.eigenchat')).toBeUndefined();
    });

    test('post message → row updates messageCount, lastAuthorEmail, lastActivityAt', async () => {
        const chatName = 'inside-container.eigenchat';

        // Find the chat by name so we can post a message to it
        const chatChildren = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docChatFolderId}`,
        );
        const chat = findOrFail(chatChildren, (c: DrivePath) => c.name === chatName);

        await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
            content: `hello ${ctx.bob.user.email}`,
        });

        const row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.messageCount).toBe(1);
        expect(row.lastAuthorEmail).toBe(ctx.alice.user.email);
        expect(row.lastActivityAt).toBeTruthy();
        expect(row.createdBy).toBe(ctx.alice.user.email);
    });

    test('resolve → status=resolved + resolvedBy set; re-open → status=open + resolvedBy null', async () => {
        const chatName = 'inside-container.eigenchat';
        const base = `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments/${chatName}`;

        await assertJson(
            await authedRequest(ctx.alice.user.sessionToken, `${base}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'resolved' }),
            }),
        );

        let row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.status).toBe('resolved');
        expect(row.resolvedBy).toBe(ctx.alice.user.email);
        expect(row.resolvedAt).toBeTruthy();

        await assertJson(
            await authedRequest(ctx.alice.user.sessionToken, `${base}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'open' }),
            }),
        );

        row = findOrFail(await listComments(), (r: CommentEntry) => r.chatName === chatName);
        expect(row.status).toBe('open');
        expect(row.resolvedBy).toBeNull();
        expect(row.resolvedAt).toBeNull();
    });

    test('bob creates a chat in alice-shared doc → createdBy is bob', async () => {
        // Give bob write access to the doc container so he can create a chat inside it
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });

        await drivePost<DrivePath>(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docChatFolderId}/create/chat`,
            { fileName: 'by-bob' },
        );

        const row = (await listComments()).find((r) => r.chatName === 'by-bob.eigenchat');
        expect(row).toBeDefined();
        expect(row!.createdBy).toBe(ctx.bob.user.email);
    });

    test('status PATCH on a nonexistent chatName → 404, no history event', async () => {
        // No .eigenchat under this name → the status write must 404, not record a phantom
        // 'resolved'/'reopened' event against a name that identifies no thread.
        const ghostName = 'ghost-status.eigenchat';
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/collab/${ctx.alice.user.id}/${mountId}/${docId}/comments/${ghostName}/status`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'resolved' }),
            },
        );
        expect(res.status).toBe(404);

        const events = await assertJson<FileEvent[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${docId}/history`,
            ),
        );
        const ghostEvent = events.some((e: FileEvent) => {
            const d = e.details;
            return (
                (e.eventType === 'resolved' || e.eventType === 'reopened') &&
                !!d &&
                'chatName' in d &&
                d.chatName === ghostName
            );
        });
        expect(ghostEvent).toBe(false);
    });
});
