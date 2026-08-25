import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage, DrivePath } from '@workspace/lib/types';
import type { DocCommentMatch } from '@workspace/lib/types/doc-search';
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
const CHARLIE_EMAIL = 'charlie@test.eigen.is';

function commentSearch(token: string, ownerId: string, mountId: string, pathId: string, q: string) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/comments/search?q=${encodeURIComponent(q)}`);
}

async function createThread(ctx: TestCtx, mountId: string, chatFolderId: string, name: string) {
    return drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${chatFolderId}/create/chat`,
        { fileName: name },
    );
}

async function postComment(ctx: TestCtx, mountId: string, chatId: string, content: string) {
    return chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chatId}/messages`, {
        content,
    });
}

describe('Comment search', () => {
    let ctx: TestCtx;
    let mountId: string;
    let docId: string;
    let chatFolderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            { fileName: 'search-comments-doc' },
        );
        docId = doc.id;
        const contents = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docId}`,
        );
        chatFolderId = findOrFail(contents, (p: DrivePath) => p.name === 'chat').id;

        const t1 = await createThread(ctx, mountId, chatFolderId, 'thread-pineapple');
        await postComment(ctx, mountId, t1.id, 'we should discuss the pineapple roadmap');
    });

    test('finds a thread by a word in its body', async () => {
        const res = await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'pineapple');
        const matches = await assertJson<DocCommentMatch[]>(res);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        const hit = findOrFail(matches, (m: DocCommentMatch) => m.id === 'thread-pineapple.eigenchat');
        expect(hit.label.toLowerCase()).toContain('pineapple');
        expect(hit.context).toBe(ctx.alice.user.email);
    });

    test('returns empty for a term in no thread', async () => {
        const res = await commentSearch(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            docId,
            'zzznotpresent',
        );
        expect(await assertJson<DocCommentMatch[]>(res)).toEqual([]);
    });

    test('garbage / operator-only query is safe and returns empty', async () => {
        const res = await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, '*(){}:^-');
        expect(res.status).toBe(200);
        expect(await assertJson<DocCommentMatch[]>(res)).toEqual([]);
    });

    test('only the recent ~8 KB tail is searchable', async () => {
        const t2 = await createThread(ctx, mountId, chatFolderId, 'thread-cap');
        await postComment(ctx, mountId, t2.id, 'earlybirdterm at the very start');
        // A newer, larger message pushes the early term past the ~8 KB cap.
        await postComment(ctx, mountId, t2.id, `freshmarkerterm ${'x'.repeat(9000)}`);

        const fresh = await assertJson<DocCommentMatch[]>(
            await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'freshmarkerterm'),
        );
        expect(fresh.some((m) => m.id === 'thread-cap.eigenchat')).toBe(true);

        const early = await assertJson<DocCommentMatch[]>(
            await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'earlybirdterm'),
        );
        expect(early.some((m) => m.id === 'thread-cap.eigenchat')).toBe(false);
    });

    test('deleted message text stops matching (recompute, not append)', async () => {
        const t3 = await createThread(ctx, mountId, chatFolderId, 'thread-delete');
        const msg = await postComment(ctx, mountId, t3.id, 'ephemeralterm should vanish on delete');
        await postComment(ctx, mountId, t3.id, 'a second message keeps the thread indexed');

        let res = await assertJson<DocCommentMatch[]>(
            await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'ephemeralterm'),
        );
        expect(res.some((m) => m.id === 'thread-delete.eigenchat')).toBe(true);

        await authedRequest(
            ctx.alice.user.sessionToken,
            `/chat/${ctx.alice.user.id}/${mountId}/${t3.id}/messages/${msg.id}`,
            { method: 'DELETE' },
        );

        res = await assertJson<DocCommentMatch[]>(
            await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'ephemeralterm'),
        );
        expect(res.some((m) => m.id === 'thread-delete.eigenchat')).toBe(false);
    });

    test('whisper text is excluded from the index', async () => {
        // Share the doc with Charlie so the whisper target is a member.
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
            add: [{ id: CHARLIE_EMAIL, read: true, write: true }],
        });
        const t4 = await createThread(ctx, mountId, chatFolderId, 'thread-whisper');
        // Whisper FIRST: a whisper never triggers a recompute itself, so the filter is only
        // exercised when a later normal message rebuilds recentText over the whole thread.
        await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${t4.id}/messages`, {
            content: 'secretwhisperterm for your eyes only',
            type: 'whisper',
            whisperTo: CHARLIE_EMAIL,
        });
        await postComment(ctx, mountId, t4.id, 'a normal keepthethread message');

        const res = await assertJson<DocCommentMatch[]>(
            await commentSearch(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'secretwhisperterm'),
        );
        expect(res.some((m) => m.id === 'thread-whisper.eigenchat')).toBe(false);
    });

    // The 403 comes from getCommentIndex → SharedDrive.getPath → withReadPermission,
    // not from the route handler — the sibling-route ACL pattern.
    describe('permissions (SharedDrive read ACL)', () => {
        test('non-member gets 403', async () => {
            const res = await commentSearch(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, docId, 'pineapple');
            expect(res.status).toBe(403);
        });

        test('reader can search after being granted access', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${docId}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            const res = await commentSearch(ctx.bob.user.sessionToken, ctx.alice.user.id, mountId, docId, 'pineapple');
            expect(res.status).toBe(200);
            const matches = await assertJson<DocCommentMatch[]>(res);
            expect(matches.some((m) => m.id === 'thread-pineapple.eigenchat')).toBe(true);
        });
    });
});
