import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { FileEvent } from '@workspace/lib/types/file-history';
import { withCommentIndex } from '../../lib/chat/comment-index';
import { getHome } from '../../lib/home';
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

    // The list leaves createdBy out, so the seed is read from comments.db itself.
    async function createdByOf(chatName: string): Promise<string | null | undefined> {
        const home = await getHome(ctx.alice.user.id);
        return withCommentIndex(home.drive, mountId, docId, async (index) => (await index.get(chatName))?.createdBy);
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
        expect(await createdByOf('inside-container.eigenchat')).toBe(ctx.alice.user.email);
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
        expect(await createdByOf(chatName)).toBe(ctx.alice.user.email);
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

        expect(await createdByOf('by-bob.eigenchat')).toBe(ctx.bob.user.email);
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
    // The second post lands while the first waits for its members. The first then writes the
    // index last, and its text must still hold both messages.
    test('two posts at once leave both messages in the thread search text', async () => {
        const { sessionToken: token, id: ownerId } = ctx.alice.user;
        const chat = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${docChatFolderId}/create/chat`, {
            fileName: 'two-posts',
        });
        const home = await getHome(ownerId);
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const members = home.drive.getEffectiveMembers.bind(home.drive);
        const spy = spyOn(home.drive, 'getEffectiveMembers').mockImplementationOnce(async (...args) => {
            entered.resolve();
            await gate.promise;
            return members(...args);
        });
        try {
            const first = chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'first post' });
            await entered.promise;
            await chatPost(token, ownerId, mountId, `${chat.id}/messages`, { content: 'second post' });
            gate.resolve();
            await first;
        } finally {
            gate.resolve();
            spy.mockRestore();
        }

        const recentText = await withCommentIndex(
            home.drive,
            mountId,
            docId,
            async (index) => (await index.get('two-posts.eigenchat'))?.recentText,
        );
        expect(recentText).toContain('first post');
        expect(recentText).toContain('second post');
    });
});
