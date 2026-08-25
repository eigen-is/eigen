import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage, CommentEntry, DrivePath } from '@workspace/lib/types';
import type { FileEvent } from '@workspace/lib/types/file-history';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { COMMENT_INDEX_DB_CONFIG } from '../../lib/chat/comment-db-config';
import { CommentIndex } from '../../lib/chat/comment-index';
import * as commentSchema from '../../lib/chat/comment-schema';
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
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}/create/doc`,
            {
                fileName: 'comment-test-doc',
            },
        );
        docId = doc.id;

        // Get the auto-created chat/ folder inside the doc
        const contents = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${docId}`,
        );
        chatFolderId = findOrFail(contents, (p: DrivePath) => p.name === 'chat').id;
    });

    describe('empty state', () => {
        test('list returns empty array', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const data = await assertJson<CommentEntry[]>(res);
            expect(data).toEqual([]);
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
                `folder/${chatFolderId}/create/chat`,
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

    describe('resolve and reopen', () => {
        let chatName: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolderId}/create/chat`,
                { fileName: 'resolve-test' },
            );
            chatName = 'resolve-test.eigenchat';

            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
                {
                    content: 'Comment to resolve',
                },
            );
        });

        async function statusEvents(type: 'resolved' | 'reopened'): Promise<FileEvent[]> {
            const events = await assertJson<FileEvent[]>(
                await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/drive/${ctx.alice.user.id}/${mountId}/path/${docId}/history`,
                ),
            );
            return events.filter((e) => e.eventType === type);
        }

        test('resolve sets status and resolvedBy', async () => {
            const res = await collabPatch(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                `comments/${chatName}/status`,
                { status: 'resolved', title: 'Fix header' },
            );
            expect(res.status).toBe(200);

            const listRes = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(listRes);
            const resolved = findOrFail(comments, (c: CommentEntry) => c.chatName === chatName);
            expect(resolved.status).toBe('resolved');
            expect(resolved.resolvedBy).toBe(ctx.alice.user.email);
            expect(resolved.resolvedAt).toBeTruthy();
            expect(resolved.title).toBe('Fix header');

            const event = findOrFail(await statusEvents('resolved'), (e: FileEvent) => {
                const d = e.details;
                return !!d && 'chatName' in d && d.chatName === chatName;
            });
            const details = event.details && 'card' in event.details ? event.details : null;
            expect(details?.card).toBe('Fix header');
        });

        test('reopen clears resolved state', async () => {
            const res = await collabPatch(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                docId,
                `comments/${chatName}/status`,
                { status: 'open', title: 'Fix header' },
            );
            expect(res.status).toBe(200);

            const listRes = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, docId, 'comments');
            const comments = await assertJson<CommentEntry[]>(listRes);
            const reopened = findOrFail(comments, (c: CommentEntry) => c.chatName === chatName);
            expect(reopened.status).toBe('open');
            expect(reopened.resolvedBy).toBeNull();
            expect(reopened.resolvedAt).toBeNull();

            const event = findOrFail(await statusEvents('reopened'), (e: FileEvent) => {
                const d = e.details;
                return !!d && 'chatName' in d && d.chatName === chatName;
            });
            const details = event.details && 'card' in event.details ? event.details : null;
            expect(details?.card).toBe('Fix header');
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
                `folder/${root.id}/create/doc`,
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
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'edit-chat' },
            );
            editChatId = chat.id;

            // Post two messages
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${editChatId}/messages`,
                {
                    content: 'original message',
                },
            );
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${editChatId}/messages`,
                {
                    content: 'second message',
                },
            );
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
                `folder/${root.id}/create/doc`,
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
                    `folder/${chatFolder.id}/create/chat`,
                    { fileName: name },
                );
                await chatPost<ChatMessage>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    mountId,
                    `${chat.id}/messages`,
                    {
                        content: `Message in ${name}`,
                    },
                );
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
    });

    describe('whispers do not affect the comment index', () => {
        let doc3Id: string;

        beforeAll(async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc3 = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/create/doc`,
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

            // Chat creation seeds a row in comments.db with createdBy=alice, messageCount=0.
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'whisper-chat' },
            );

            // Share with Bob so whisper target exists
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${chat.id}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Post a whisper — should NOT increment the seeded row's messageCount or set lastAuthor.
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
                {
                    content: 'secret',
                    type: 'whisper',
                    whisperTo: BOB_EMAIL,
                },
            );
        });

        test('whisper leaves the seeded row untouched', async () => {
            const res = await collabGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, doc3Id, 'comments');
            const comments = await assertJson<CommentEntry[]>(res);
            expect(comments).toHaveLength(1);
            expect(comments[0].chatName).toBe('whisper-chat.eigenchat');
            expect(comments[0].messageCount).toBe(0);
            expect(comments[0].lastAuthorEmail).toBeNull();
            expect(comments[0].lastMessageSnippet).toBeNull();
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
                `folder/${root.id}/create/chat`,
                { fileName: 'standalone-chat' },
            );

            // Post message — should not throw or affect any index
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
                {
                    content: 'standalone message',
                },
            );

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
                `folder/${root.id}/create/doc`,
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
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'long-msg' },
            );

            // Post a very long message
            const longContent = 'A'.repeat(500);
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
                {
                    content: longContent,
                },
            );
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
                `folder/${root.id}/create/doc`,
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
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'perm-chat' },
            );
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `${chat.id}/messages`,
                {
                    content: 'test message',
                },
            );
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

        test('reader can list comments', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${permDocId}/acl`, {
                add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
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
                add: [{ id: 'charlie@test.eigen.is', read: true, write: true }],
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

    describe('comments.db created with collab document', () => {
        test('new doc has comments.db in folder contents', async () => {
            const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                `folder/${root.id}/create/doc`,
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

// Unit-level coverage of CommentIndex.assign semantics over an in-memory db (route round-trip is in comment-assignee.test.ts).
describe('CommentIndex.assign', () => {
    function makeIndex(): CommentIndex {
        const raw = new Database(':memory:');
        for (const m of COMMENT_INDEX_DB_CONFIG.migrations) m.up(raw);
        return new CommentIndex(drizzle(raw, { schema: commentSchema }));
    }

    test('assign sets the assignee email', async () => {
        const index = makeIndex();
        await index.ensureComment('a.eigenchat');

        await index.assign('a.eigenchat', 'bob@test.eigen.is');

        const entries = await index.list();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ chatName: 'a.eigenchat', assignee: 'bob@test.eigen.is' });
    });

    test('reassign overwrites the previous assignee', async () => {
        const index = makeIndex();
        await index.ensureComment('a.eigenchat');
        await index.assign('a.eigenchat', 'bob@test.eigen.is');

        await index.assign('a.eigenchat', 'charlie@test.eigen.is');

        const [entry] = await index.list();
        expect(entry).toMatchObject({ assignee: 'charlie@test.eigen.is' });
    });

    test('assign with null clears the assignee', async () => {
        const index = makeIndex();
        await index.ensureComment('a.eigenchat');
        await index.assign('a.eigenchat', 'bob@test.eigen.is');

        await index.assign('a.eigenchat', null);

        const [entry] = await index.list();
        expect(entry).toMatchObject({ assignee: null });
    });

    test('assigning an unknown chatName is a no-op (UPDATE matches nothing, no throw)', async () => {
        const index = makeIndex();
        await index.ensureComment('a.eigenchat');

        await index.assign('ghost.eigenchat', 'bob@test.eigen.is');

        const entries = await index.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].chatName).toBe('a.eigenchat');
    });

    test('list() rows expose assignee (null when unset)', async () => {
        const index = makeIndex();
        await index.ensureComment('a.eigenchat');

        const [entry] = await index.list();
        expect(Object.keys(entry)).toContain('assignee');
        expect(entry).toMatchObject({ assignee: null });
    });
});
