import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage, CommentEntry, DrivePath } from '@workspace/lib/types';
import { assertJson, authedRequest, chatPost, driveGet, drivePost, drivePut, findOrFail, getTestContext } from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';

function collabGet(token: string, ownerId: string, mountId: string, pathId: string, sub: string) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/${sub}`);
}

function collabPatch(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    sub: string,
    body: Record<string, unknown>,
) {
    return authedRequest(token, `/collab/${ownerId}/${mountId}/${pathId}/${sub}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('Comment Index', () => {
    let ctx: TestCtx;
    let mountId: string;
    let docId: string;
    let chatFolderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');

        // Create a doc — CollabDocument.create() creates comments.db + chat/ folder
        const doc = await drivePost<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${root.id}/doc`, {
            fileName: 'comment-test-doc',
        });
        docId = doc.id;

        // Get the auto-created chat/ folder inside the doc
        const contents = await driveGet<DrivePath[]>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${docId}`);
        chatFolderId = findOrFail(contents, (p: DrivePath) => p.name === 'chat').id;
    });

    describe('empty state', () => {
        test('list returns empty array', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const data = await assertJson<CommentEntry[]>(res);
            expect(data).toEqual([]);
        });

        test('unresolved count is zero', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                'comments/unresolved-count',
            );
            const data = await assertJson<{ count: number }>(res);
            expect(data).toEqual({ count: 0 });
        });
    });

    describe('comment creation via chat message', () => {
        let chatId: string;

        beforeAll(async () => {
            // Create a chat inside the doc's chat/ folder
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolderId}/chat`,
                { fileName: 'discussion-1' },
            );
            chatId = chat.id;

            // Post a message — triggers comment index update
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chatId}/messages`, {
                content: 'First comment message',
            });
        });

        test('comment appears in list after message post', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments).toHaveLength(1);
            expect(comments[0].chatName).toBe('discussion-1.eigenchat');
            expect(comments[0].status).toBe('open');
            expect(comments[0].lastAuthorEmail).toBe(ctx.alice.user.email);
            expect(comments[0].lastMessageSnippet).toBe('First comment message');
            expect(comments[0].messageCount).toBe(1);
        });

        test('unresolved count is 1', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                'comments/unresolved-count',
            );
            const data = await assertJson<{ count: number }>(res);
            expect(data).toEqual({ count: 1 });
        });

        test('second message updates activity', async () => {
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chatId}/messages`, {
                content: 'Follow-up message',
            });

            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments[0].lastMessageSnippet).toBe('Follow-up message');
            expect(comments[0].messageCount).toBe(2);
        });
    });

    describe('mention tracking', () => {
        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolderId}/chat`,
                { fileName: 'mention-test' },
            );

            // Post a message mentioning Bob
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: `Hey ${BOB_EMAIL} check this out`,
            });
        });

        test('comment list includes mentions array with mentioned emails', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            const mentionComment = findOrFail(comments, (c: CommentEntry) => c.chatName === 'mention-test.eigenchat');
            expect(mentionComment.mentions).toContain(BOB_EMAIL);
        });

        test('non-mention comments have empty mentions array', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            const firstComment = findOrFail(comments, (c: CommentEntry) => c.chatName === 'discussion-1.eigenchat');
            expect(firstComment.mentions).toEqual([]);
        });

        test('duplicate mention in second message does not create duplicate entry', async () => {
            const chatFolder = findOrFail(
                await driveGet<DrivePath[]>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${docId}`),
                (p: DrivePath) => p.name === 'chat',
            );
            const chats = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}`,
            );
            const mentionChat = findOrFail(chats, (c: DrivePath) => c.name === 'mention-test.eigenchat');

            // Post another message mentioning Bob again
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${mentionChat.id}/messages`, {
                content: `${BOB_EMAIL} please see above`,
            });

            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            const mentionComment = findOrFail(comments, (c: CommentEntry) => c.chatName === 'mention-test.eigenchat');
            // Still just one mention of Bob, not two
            expect(mentionComment.mentions.filter((e: string) => e === BOB_EMAIL)).toHaveLength(1);
        });
    });

    describe('resolve and reopen', () => {
        let chatName: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolderId}/chat`,
                { fileName: 'resolve-test' },
            );
            chatName = 'resolve-test.eigenchat';

            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: 'Comment to resolve',
            });
        });

        test('resolve sets status and resolvedBy', async () => {
            const res = await collabPatch(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                `comments/${chatName}/status`,
                { status: 'resolved' },
            );
            expect(res.status).toBe(200);

            const listRes = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(listRes);
            const resolved = findOrFail(comments, (c: CommentEntry) => c.chatName === chatName);
            expect(resolved.status).toBe('resolved');
            expect(resolved.resolvedBy).toBe(ctx.alice.user.email);
            expect(resolved.resolvedAt).toBeTruthy();
        });

        test('resolved comment decreases unresolved count', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                'comments/unresolved-count',
            );
            const body = await assertJson<{ count: number }>(res);
            // Other comments from previous tests are still open
            // The resolved one should not be counted
            const listRes = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(listRes);
            const openCount = comments.filter((c: CommentEntry) => c.status === 'open').length;
            expect(body.count).toBe(openCount);
        });

        test('reopen clears resolved state', async () => {
            const res = await collabPatch(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                `comments/${chatName}/status`,
                { status: 'open' },
            );
            expect(res.status).toBe(200);

            const listRes = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(listRes);
            const reopened = findOrFail(comments, (c: CommentEntry) => c.chatName === chatName);
            expect(reopened.status).toBe('open');
            expect(reopened.resolvedBy).toBeNull();
            expect(reopened.resolvedAt).toBeNull();
        });
    });

    describe('edit and delete update index', () => {
        let editDocId: string;
        let editChatId: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'edit-delete-doc' },
            );
            editDocId = doc.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${editDocId}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'edit-chat' },
            );
            editChatId = chat.id;

            // Post two messages
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${editChatId}/messages`, {
                content: 'original message',
            });
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${editChatId}/messages`, {
                content: 'second message',
            });
        });

        test('edit updates snippet', async () => {
            // Get messages to find the last one
            const messages = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${editChatId}/messages`,
            );
            const msgs = await assertJson<ChatMessage[]>(messages);
            const lastMsg = msgs[msgs.length - 1];

            // Edit the last message
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${editChatId}/messages/${lastMsg.id}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'edited content' }),
                },
            );

            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, editDocId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments[0].lastMessageSnippet).toBe('edited content');
        });

        test('delete decrements count', async () => {
            // Get current count
            const before = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                editDocId,
                'comments',
            );
            const commentsBefore = await assertJson<CommentEntry[]>(before);
            const countBefore = commentsBefore[0].messageCount;

            // Get messages and delete the last one
            const messages = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${editChatId}/messages`,
            );
            const msgs = await assertJson<ChatMessage[]>(messages);
            const lastMsg = msgs[msgs.length - 1];

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${editChatId}/messages/${lastMsg.id}`,
                {
                    method: 'DELETE',
                },
            );

            const after = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                editDocId,
                'comments',
            );
            const commentsAfter = await assertJson<CommentEntry[]>(after);
            expect(commentsAfter[0].messageCount).toBe(countBefore - 1);
        });
    });

    describe('multiple comments', () => {
        let doc2Id: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc2 = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'multi-comment-doc' },
            );
            doc2Id = doc2.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${doc2Id}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            // Create 3 chats and post messages
            for (const name of ['comment-a', 'comment-b', 'comment-c']) {
                const chat = await drivePost<DrivePath>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    `folder/${chatFolder.id}/chat`,
                    { fileName: name },
                );
                await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                    content: `Message in ${name}`,
                });
            }
        });

        test('all comments listed in creation order', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, doc2Id, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments).toHaveLength(3);
            expect(comments.map((c: CommentEntry) => c.chatName)).toEqual([
                'comment-a.eigenchat',
                'comment-b.eigenchat',
                'comment-c.eigenchat',
            ]);
        });

        test('unresolved count reflects all open comments', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                doc2Id,
                'comments/unresolved-count',
            );
            const data = await assertJson<{ count: number }>(res);
            expect(data).toEqual({ count: 3 });
        });
    });

    describe('whispers are not indexed', () => {
        let doc3Id: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc3 = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'whisper-doc' },
            );
            doc3Id = doc3.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${doc3Id}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'whisper-chat' },
            );

            // Share with Bob so whisper target exists
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${chat.id}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Post a whisper — should NOT create a comment index entry
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: 'secret',
                type: 'whisper',
                whisperTo: BOB_EMAIL,
            });
        });

        test('whisper does not create comment entry', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, doc3Id, 'comments');
            expect(await res.json()).toEqual([]);
        });
    });

    describe('standalone chat is not indexed', () => {
        test('standalone chat messages do not affect any comment index', async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');

            // Create standalone chat (not inside a doc)
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/chat`,
                { fileName: 'standalone-chat' },
            );

            // Post message — should not throw or affect any index
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: 'standalone message',
            });

            // Verify the message was posted successfully
            const messages = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${mountId}/${chat.id}/messages`,
            );
            const msgs = await assertJson<ChatMessage[]>(messages);
            expect(msgs.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('snippet truncation', () => {
        let doc4Id: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc4 = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'truncation-doc' },
            );
            doc4Id = doc4.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${doc4Id}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'long-msg' },
            );

            // Post a very long message
            const longContent = 'A'.repeat(500);
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: longContent,
            });
        });

        test('snippet is truncated to 100 chars', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, doc4Id, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments[0].lastMessageSnippet).toHaveLength(100);
        });
    });

    describe('permissions', () => {
        let permDocId: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'perm-doc' },
            );
            permDocId = doc.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${permDocId}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'perm-chat' },
            );
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: 'test message',
            });
        });

        test('user without access gets 403 on list', async () => {
            const res = await collabGet(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                permDocId,
                'comments',
            );
            expect(res.status).toBe(403);
        });

        test('user without access gets 403 on unresolved-count', async () => {
            const res = await collabGet(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                permDocId,
                'comments/unresolved-count',
            );
            expect(res.status).toBe(403);
        });

        test('reader can list comments', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${permDocId}/acl`, {
                acl: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
            });

            const res = await collabGet(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                permDocId,
                'comments',
            );
            expect(res.status).toBe(200);
        });

        test('reader cannot resolve comments', async () => {
            const res = await collabPatch(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                permDocId,
                'comments/perm-chat.eigenchat/status',
                { status: 'resolved' },
            );
            expect(res.status).toBe(403);
        });

        test('writer can resolve comments', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${permDocId}/acl`, {
                acl: [{ id: 'charlie@test.eigen.is', read: true, write: true }],
            });

            const res = await collabPatch(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                permDocId,
                'comments/perm-chat.eigenchat/status',
                { status: 'resolved' },
            );
            expect(res.status).toBe(200);
        });
    });

    describe('nonexistent container', () => {
        test('comments on nonexistent path returns 404', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                'nonexistent-id',
                'comments',
            );
            expect(res.status).toBe(404);
        });
    });

    describe('multiple mentions in one message', () => {
        let mentionDocId: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'multi-mention-doc' },
            );
            mentionDocId = doc.id;

            // Share with Bob and Charlie
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${mentionDocId}/acl`, {
                acl: [
                    { id: BOB_EMAIL, read: true, write: true },
                    { id: 'charlie@test.eigen.is', read: true, write: true },
                ],
            });

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${mentionDocId}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'multi-mention' },
            );

            // Mention both Bob and Charlie in one message
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: `Hey ${BOB_EMAIL} and charlie@test.eigen.is please review`,
            });
        });

        test('mentions array contains both emails', async () => {
            const res = await collabGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                mentionDocId,
                'comments',
            );
            const comments = await assertJson<CommentEntry[]>(res);
            const comment = findOrFail(comments, (c: CommentEntry) => c.chatName === 'multi-mention.eigenchat');
            expect(comment.mentions).toContain(BOB_EMAIL);
            expect(comment.mentions).toContain('charlie@test.eigen.is');
            expect(comment.mentions).toHaveLength(2);
        });
    });

    describe('email case insensitivity in mentions', () => {
        let caseDocId: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'case-mention-doc' },
            );
            caseDocId = doc.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${caseDocId}/acl`, {
                acl: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${caseDocId}`,
            );
            const chatFolder = findOrFail(contents, (p: DrivePath) => p.name === 'chat');

            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/chat`,
                { fileName: 'case-mention' },
            );

            // Mention Bob with uppercase email
            await chatPost<ChatMessage>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
                content: 'Hey BOB@TEST.EIGEN.IS check this',
            });
        });

        test('mention is stored lowercase', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, caseDocId, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            const comment = findOrFail(comments, (c: CommentEntry) => c.chatName === 'case-mention.eigenchat');
            // Stored as lowercase despite uppercase input
            expect(comment.mentions).toContain(BOB_EMAIL);
        });
    });

    describe('comments.db created with collab document', () => {
        test('new doc has comments.db in folder contents', async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/doc`,
                { fileName: 'check-comments-db' },
            );

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${doc.id}`,
            );
            const commentsDb = contents.find((p: DrivePath) => p.name === 'comments.db');
            expect(commentsDb).toBeTruthy();
        });
    });
});
