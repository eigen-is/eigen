import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage, DrivePath } from '@workspace/lib/types';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types';
import type { Notification } from '@workspace/lib/types/notification';
import { authedRequest, chatGet, chatPost, driveGet, drivePost, findOrFail, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function chatPostRaw(
    token: string,
    ownerId: string,
    mountId: string,
    path: string,
    body: Record<string, unknown>,
): Promise<Response> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('Chat', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;

        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    describe('Chat Creation', () => {
        let chatId: string;

        test('create chat', async () => {
            const data = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Team Chat' },
            );
            expect(data.name).toBe('Team Chat.eigenchat');
            expect(data.type).toBe('chat');
            expect(data.mimeType).toBe(DRIVE_MIME_CHAT);
            chatId = data.id;
        });

        test('chat appears in folder listing', async () => {
            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
            );
            const chat = findOrFail(contents, (item: DrivePath) => item.id === chatId);
            expect(chat.type).toBe('chat');
        });

        test('chat has data.db and media subfolder', async () => {
            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${chatId}`,
            );
            expect(Array.isArray(contents)).toBe(true);
            findOrFail(contents, (item: DrivePath) => item.name === 'data.db');
            const media = findOrFail(contents, (item: DrivePath) => item.name === 'media');
            expect(media.type).toBe('folder');
        });
    });

    describe('Embedded Chat in Doc', () => {
        let docId: string;

        test('create doc creates chat/ subfolder with General chat', async () => {
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'Test Doc' },
            );
            docId = doc.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${docId}`,
            );
            const chatFolder = findOrFail(contents, (item: DrivePath) => item.name === 'chat');
            expect(chatFolder.type).toBe('folder');
        });
    });

    describe('Messages', () => {
        let chatId: string;
        let messageId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Message Test Chat' },
            );
            chatId = chat.id;
        });

        test('post message', async () => {
            const data = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Hello, world!' },
            );
            expect(data.id).toBeDefined();
            expect(data.content).toBe('Hello, world!');
            expect(data.type).toBe('message');
            expect(data.authorId).toBe(ctx.alice.user.id);
            expect(data.authorEmail).toBe(ctx.alice.user.email);
            messageId = data.id;
        });

        test('get messages returns posted message', async () => {
            const data = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(1);
            expect(data[0].content).toBe('Hello, world!');
        });

        test('post emote message', async () => {
            const data = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'waves', type: 'emote' },
            );
            expect(data.type).toBe('emote');
            expect(data.content).toBe('waves');
        });

        test('edit message', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${messageId}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Hello, edited!' }),
                },
            );
            const data = (await res.json()) as ChatMessage;
            expect(data.content).toBe('Hello, edited!');
            expect(data.editedAt).toBeDefined();
        });

        test('delete message (soft delete)', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${messageId}`,
                {
                    method: 'DELETE',
                },
            );
            const data = (await res.json()) as { success: boolean };
            expect(data.success).toBe(true);
        });

        test('mark as read', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const lastMsg = msgs[msgs.length - 1];

            const data = await chatPost<{ success: boolean }>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/read`,
                { messageId: lastMsg.id },
            );
            expect(data.success).toBe(true);
        });

        test('reply to message', async () => {
            const original = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Original message' },
            );

            const reply = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'This is a reply', replyTo: original.id },
            );
            expect(reply.replyTo).toBe(original.id);
        });
    });

    describe('Message limit query param', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Limit Test Chat' },
            );
            chatId = chat.id;

            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Hello, world!' },
            );
        });

        test('non-numeric limit is rejected with 422', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages?limit=abc`,
            );
            expect(res.status).toBe(422);
        });

        test('fractional limit is rejected with 422', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages?limit=1.5`,
            );
            expect(res.status).toBe(422);
        });

        test('valid numeric limit still works', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages?limit=1`,
            );
            expect(msgs.length).toBe(1);
        });
    });

    describe('Whisper Visibility', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Whisper Test Chat' },
            );
            chatId = chat.id;

            const BOB_EMAIL = 'bob@test.eigen.is';
            const CHARLIE_EMAIL = 'charlie@test.eigen.is';
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [
                            { id: BOB_EMAIL, read: true, write: true },
                            { id: CHARLIE_EMAIL, read: true, write: true },
                        ],
                    }),
                },
            );
        });

        test('Alice whispers to Bob', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                {
                    content: 'Secret message for Bob only',
                    type: 'whisper',
                    whisperTo: ctx.bob.user.email,
                },
            );
            expect(msg.type).toBe('whisper');
            expect(msg.whisperTo).toBe(ctx.bob.user.email);
            expect(msg.content).toBe('Secret message for Bob only');
        });

        test('Alice posts a normal message', async () => {
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                {
                    content: 'Public message from Alice',
                },
            );
        });

        test('Alice sees whisper content (she is the author)', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const whisper = findOrFail(msgs, (m: ChatMessage) => m.type === 'whisper');
            expect(whisper.content).toContain('whispers to');
            expect(whisper.content).toContain('Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.email);
        });

        test('Bob sees whisper content (he is the recipient)', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const whisper = findOrFail(msgs, (m: ChatMessage) => m.type === 'whisper');
            expect(whisper.content).toBe('whispers to you: Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.email);
        });

        test('Charlie sees whisper exists but content is hidden', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const whisper = findOrFail(msgs, (m: ChatMessage) => m.type === 'whisper');
            expect(whisper.content).toContain('[a few hushed words]');
            expect(whisper.whisperTo).toBeNull();
        });

        test('Charlie sees normal messages normally', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const normal = findOrFail(msgs, (m: ChatMessage) => m.type === 'message');
            expect(normal.content).toBe('Public message from Alice');
        });
    });

    describe('Attachments', () => {
        let chatId: string;
        let mediaFolderId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Attachment Test Chat' },
            );
            chatId = chat.id;

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${chatId}`,
            );
            const media = findOrFail(contents, (item: DrivePath) => item.name === 'media');
            mediaFolderId = media.id;
        });

        test('upload file to media and post message with attachment', async () => {
            const file = new File(['attachment content'], 'test-attachment.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${mediaFolderId}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );
            const uploadedArr = (await uploadRes.json()) as DrivePath[];
            const uploaded = uploadedArr[0];
            expect(uploaded.id).toBeDefined();
            expect(uploaded.name).toBe('test-attachment.txt');

            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Message with attachment', attachments: [uploaded.name] },
            );
            expect(msg.id).toBeDefined();
            expect(msg.content).toBe('Message with attachment');
            expect(msg.attachments).toEqual([uploaded.name]);
        });

        test('get messages returns attachment names', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const withAttachment = findOrFail(
                msgs,
                (m: ChatMessage) => m.attachments !== null && m.attachments.length > 0,
            );
            expect(withAttachment.attachments).toHaveLength(1);
        });

        // Attachments are stored by file name (matching the client), so the message references
        // the media file by name — deleting the message must clean that file up.
        test('deleting message also deletes attachment file', async () => {
            const file = new File(['delete-me'], 'delete-me.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${mediaFolderId}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );
            const uploaded = ((await uploadRes.json()) as DrivePath[])[0];

            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Will be deleted', attachments: [uploaded.name] },
            );

            const deleteRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'DELETE',
                },
            );
            const deleteData = (await deleteRes.json()) as { success: boolean };
            expect(deleteData.success).toBe(true);

            const mediaContents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${mediaFolderId}`,
            );
            const deletedFile = mediaContents.find((item: DrivePath) => item.id === uploaded.id);
            expect(deletedFile).toBeUndefined();
        });

        test('post message with reference attachment', async () => {
            const ref = {
                type: 'reference' as const,
                ownerId: ctx.alice.user.id,
                mountId: aliceMountId,
                id: 'fake-eigendoc-id',
                name: 'My Notes.eigendoc',
                driveType: 'doc',
                mimeType: 'application/eigendoc',
            };

            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Message with reference', attachments: [ref] },
            );
            expect(msg.id).toBeDefined();
            expect(msg.content).toBe('Message with reference');
            expect(msg.attachments).toHaveLength(1);
            expect(msg.attachments![0]).toMatchObject(ref);
        });

        test('deleting message with reference attachment does not error', async () => {
            const ref = {
                type: 'reference' as const,
                ownerId: ctx.alice.user.id,
                mountId: aliceMountId,
                id: 'fake-eigendoc-id',
                name: 'My Notes.eigendoc',
                driveType: 'doc',
                mimeType: 'application/eigendoc',
            };

            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Will be deleted with ref', attachments: [ref] },
            );

            const deleteRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'DELETE',
                },
            );
            const deleteData = (await deleteRes.json()) as { success: boolean };
            expect(deleteData.success).toBe(true);
        });

        test('post message with mixed file and reference attachments', async () => {
            const file = new File(['mixed content'], 'mixed-attachment.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${mediaFolderId}`,
                {
                    method: 'POST',
                    body: formData,
                },
            );
            const fileName = ((await uploadRes.json()) as DrivePath[])[0].name;

            const ref = {
                type: 'reference' as const,
                ownerId: ctx.alice.user.id,
                mountId: aliceMountId,
                id: 'fake-eigendoc-id',
                name: 'My Notes.eigendoc',
                driveType: 'doc',
                mimeType: 'application/eigendoc',
            };

            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Message with mixed attachments', attachments: [fileName, ref] },
            );
            expect(msg.id).toBeDefined();
            expect(msg.content).toBe('Message with mixed attachments');
            expect(msg.attachments).toHaveLength(2);
            expect(msg.attachments![0]).toBe(fileName);
            expect(msg.attachments![1]).toMatchObject(ref);
        });
    });

    // A message attachment is a file name inside the chat's own media/ folder. A crafted string
    // that happens to be a pathId elsewhere in the owner's mount must NOT be deletable this way —
    // deleteMessage authorizes against the home owner, so unscoped deletes were an ACL bypass.
    describe('Attachment Delete Security', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Attachment Security Chat' },
            );
            chatId = chat.id;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: ctx.bob.user.email, read: true, write: true }] }),
                },
            );
        });

        test('deleting a message cannot trash a path outside the chat media folder', async () => {
            // Alice's private file, in her root — never shared with Bob and not in the chat's media/.
            const file = new File(['owner-only secret'], 'alice-secret.txt', { type: 'text/plain' });
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${aliceRootId}`,
                { method: 'POST', body: formData },
            );
            const outsideId = ((await uploadRes.json()) as DrivePath[])[0].id;

            // Bob has write to the chat, so he can post and delete his own message. The crafted
            // attachment points at Alice's private pathId, which he cannot write to directly.
            const msg = await chatPost<ChatMessage>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'trying to trash a path I cannot write', attachments: [outsideId] },
            );
            const deleteRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                { method: 'DELETE' },
            );
            expect(((await deleteRes.json()) as { success: boolean }).success).toBe(true);

            // Alice's file must survive — it was never in the chat's media/ folder.
            const rootContents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
            );
            expect(rootContents.find((item: DrivePath) => item.id === outsideId)).toBeDefined();
        });
    });

    describe('Slash Commands', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Slash Command Chat' },
            );
            chatId = chat.id;

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
        });

        for (const emote of ['dance', 'cheer', 'taunt', 'greet']) {
            test(`/${emote} creates built-in emote`, async () => {
                const msg = await chatPost<ChatMessage>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    aliceMountId,
                    `${chatId}/messages`,
                    { content: `/${emote}` },
                );
                expect(msg.type).toBe('emote');
                expect(msg.content).toBe(`$${emote}`);
            });
        }

        test('/me creates custom emote', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: '/me tips hat' },
            );
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('tips hat');
        });

        test('emote first person for author', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const dance = msgs.find(
                (m: ChatMessage) => m.type === 'emote' && m.content === 'You dance around the room.',
            );
            expect(dance).toBeDefined();
        });

        test('emote third person for other user', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const dance = msgs.find(
                (m: ChatMessage) => m.type === 'emote' && m.content.includes('dances around the room.'),
            );
            expect(dance).toBeDefined();
        });

        test('custom emote formatted with author name for other user', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const me = findOrFail(msgs, (m: ChatMessage) => m.type === 'emote' && m.content.includes('tips hat'));
            expect(me.content).toContain(ctx.alice.user.email.split('@')[0]);
        });

        test('/whisper creates whisper message', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: `/whisper ${ctx.bob.user.email} secret hello` },
            );
            expect(msg.type).toBe('whisper');
            expect(msg.whisperTo).toBe(ctx.bob.user.email);
            expect(msg.content).toBe('secret hello');
        });

        test('/tell alias works for whisper', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: `/tell ${ctx.bob.user.email} tell msg` },
            );
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('tell msg');
        });

        test('whisper to non-existent user returns error', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '/whisper nobody@fake.eigen.is hello' }),
                },
            );
            expect(res.status).toBe(404);
        });

        test('whisper to non-existent user does not create a message', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const leaked = msgs.find(
                (m: ChatMessage) => m.content === 'hello' && m.whisperTo === 'nobody@fake.eigen.is',
            );
            expect(leaked).toBeUndefined();
        });

        test('whisper via type field to non-existent user returns error', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: 'direct whisper',
                        type: 'whisper',
                        whisperTo: 'ghost@fake.eigen.is',
                    }),
                },
            );
            expect(res.status).toBe(404);
        });

        test('Bob sees whisper sent via /whisper command', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const whisper = findOrFail(
                msgs,
                (m: ChatMessage) => m.type === 'whisper' && m.content === 'whispers to you: secret hello',
            );
            expect(whisper.whisperTo).toBe(ctx.bob.user.email);
        });

        test('invalid command returns 400 error', async () => {
            const response = await chatPostRaw(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: '/unknown command here' },
            );
            expect(response.status).toBe(400);
        });

        test('explicit type overrides command parsing', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'explicit emote', type: 'emote' },
            );
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('explicit emote');
        });
    });

    describe('Read-Only Access', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Read Only Chat' },
            );
            chatId = chat.id;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
                    }),
                },
            );

            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                {
                    content: 'Hello from Alice',
                },
            );
        });

        test('Bob can read messages with read-only access', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            expect(msgs.length).toBeGreaterThanOrEqual(1);
            const aliceMsg = msgs.find((m: ChatMessage) => m.content === 'Hello from Alice');
            expect(aliceMsg).toBeDefined();
        });

        test('Bob cannot post message with read-only access', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Bob tries to post' }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('Bob cannot edit messages with read-only access', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const msg = msgs[0];
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'Bob edits' }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('Bob cannot delete messages with read-only access', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const msg = msgs[0];
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(res.status).toBe(403);
        });

        test('Bob cannot use slash commands with read-only access', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '/dance' }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('Bob cannot whisper with read-only access', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: `/whisper ${ctx.alice.user.email} secret` }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('Alice can still post (owner has write access)', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Alice can still write' },
            );
            expect(msg.type).toBe('message');
            expect(msg.content).toBe('Alice can still write');
        });

        test('Bob read-only messages not leaked from failed posts', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const bobMsg = msgs.find((m: ChatMessage) => m.content === 'Bob tries to post');
            expect(bobMsg).toBeUndefined();
        });

        test('upgrading Bob to write allows posting', async () => {
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

            const msg = await chatPost<ChatMessage>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Bob can now write!' },
            );
            expect(msg.type).toBe('message');
            expect(msg.content).toBe('Bob can now write!');
        });
    });

    describe('New Emote Commands', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Emote Chat' },
            );
            chatId = chat.id;
        });

        for (const emote of ['allthethings', 'facepalm', 'shrug', 'flip']) {
            test(`/${emote} creates emote`, async () => {
                const msg = await chatPost<ChatMessage>(
                    ctx.alice.user.sessionToken,
                    ctx.alice.user.id,
                    aliceMountId,
                    `${chatId}/messages`,
                    { content: `/${emote}` },
                );
                expect(msg.type).toBe('emote');
                expect(msg.content).toBe(`$${emote}`);
            });
        }

        test('allthethings emote shows correct first person text', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const emote = findOrFail(
                msgs,
                (m: ChatMessage) => m.type === 'emote' && m.content.includes('ALL THE THINGS'),
            );
            expect(emote.content).toContain('\\o/');
        });

        test('shrug emote shows kaomoji', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const emote = findOrFail(msgs, (m: ChatMessage) => m.type === 'emote' && m.content.includes('shrug'));
            expect(emote.content).toContain('¯\\_(ツ)_/¯');
        });

        test('flip emote shows table flip', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const emote = findOrFail(msgs, (m: ChatMessage) => m.type === 'emote' && m.content.includes('flip'));
            expect(emote.content).toContain('(╯°□°)╯︵ ┻━┻');
        });
    });

    describe('Backend Validation', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Validation Chat' },
            );
            chatId = chat.id;

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
        });

        test('whisper to non-email target returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '/whisper bob hello there' }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('whisper via type field with non-email target returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: 'hello', type: 'whisper', whisperTo: 'justAUsername' }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('whisper to non-email does not store message', async () => {
            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const leaked = msgs.find((m: ChatMessage) => m.content.includes('hello there') || m.whisperTo === 'bob');
            expect(leaked).toBeUndefined();
        });

        test('whisper with valid email to existing user succeeds', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: `/whisper ${ctx.bob.user.email} valid whisper` },
            );
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('valid whisper');
        });

        test('delete message clears content in database', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'This will be deleted' },
            );
            expect(msg.id).toBeDefined();

            const delRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'DELETE',
                },
            );
            const delData = (await delRes.json()) as { success: boolean };
            expect(delData.success).toBe(true);

            const msgs = await chatGet<ChatMessage[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
            );
            const deleted = findOrFail(msgs, (m: ChatMessage) => m.id === msg.id);
            expect(deleted.deletedAt).not.toBeNull();
            expect(deleted.content).toBe('');
        });

        test('delete message by non-owner fails', async () => {
            const msg = await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Alice message' },
            );

            const delRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(delRes.status).toBe(404);
        });

        test('/tell alias with non-email target returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '/tell noEmail hi' }),
                },
            );
            expect(res.status).toBe(400);
        });
    });

    describe('Delete Chat', () => {
        test('create and delete chat', async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Deletable Chat' },
            );

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chat.id}`,
                { method: 'DELETE' },
            );
            const data = (await res.json()) as { success: boolean };
            expect(data.success).toBe(true);

            const contents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
            );
            const deleted = contents.find((item: DrivePath) => item.id === chat.id);
            expect(deleted).toBeUndefined();
        });
    });

    describe('Activity Notifications', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/chat`,
                { fileName: 'Notification Chat' },
            );
            chatId = chat.id;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [
                            { id: ctx.bob.user.email, read: true, write: true },
                            { id: ctx.charlie.user.email, read: true, write: true },
                        ],
                    }),
                },
            );

            // Clear any existing notifications
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}/mark-all-read`, {
                method: 'POST',
            });
            await authedRequest(ctx.charlie.user.sessionToken, `/notifications/${ctx.charlie.user.id}/mark-all-read`, {
                method: 'POST',
            });
        });

        test('posting a message notifies previous participants', async () => {
            // Alice posts first message
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Hello from Alice' },
            );

            // Bob posts second message — Alice (owner + previous author) should be notified
            await chatPost<ChatMessage>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Hello from Bob' },
            );

            const res = await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`);
            const notifications = (await res.json()) as Notification[];
            const chatNotification = notifications.find(
                (n) => n.type === 'chat-message' && n.title.includes('Notification Chat'),
            );
            expect(chatNotification).toBeDefined();
            expect(chatNotification!.actorEmail).toBe(ctx.bob.user.email);
            expect(chatNotification!.title).toBe('New message from Bob Test in "Notification Chat"');
            expect(chatNotification!.body).toBe('Hello from Bob');
        });

        test('author does not receive own notification', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`);
            const notifications = (await res.json()) as Notification[];
            const selfNotification = notifications.find(
                (n) => n.type === 'chat-message' && n.actorEmail === ctx.bob.user.email,
            );
            expect(selfNotification).toBeUndefined();
        });

        test('whisper notifies only the recipient', async () => {
            // Clear notifications
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}/mark-all-read`, {
                method: 'POST',
            });
            await authedRequest(ctx.charlie.user.sessionToken, `/notifications/${ctx.charlie.user.id}/mark-all-read`, {
                method: 'POST',
            });

            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: 'Whisper for Bob', type: 'whisper', whisperTo: ctx.bob.user.email },
            );

            // Bob should get a notification
            const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`);
            const bobNotifications = (await bobRes.json()) as Notification[];
            const bobWhisperNotif = bobNotifications.find((n) => !n.read && n.body === 'Whisper for Bob');
            expect(bobWhisperNotif).toBeDefined();
            expect(bobWhisperNotif!.type).toBe('chat-message');

            // Charlie should NOT get a notification for the whisper
            const charlieRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/notifications/${ctx.charlie.user.id}`,
            );
            const charlieNotifications = (await charlieRes.json()) as Notification[];
            const charlieWhisperNotif = charlieNotifications.find((n) => !n.read && n.body === 'Whisper for Bob');
            expect(charlieWhisperNotif).toBeUndefined();
        });

        test('mentioned user gets mention notification but not chat-message', async () => {
            // Clear notifications
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}/mark-all-read`, {
                method: 'POST',
            });

            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${chatId}/messages`,
                { content: `Hey @${ctx.bob.user.email} check this out` },
            );

            const res = await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`);
            const notifications = (await res.json()) as Notification[];
            const unread = notifications.filter((n) => !n.read);
            const mention = unread.find((n) => n.type === 'mention-chat');
            const chatMessage = unread.find((n) => n.type === 'chat-message');
            expect(mention).toBeDefined();
            expect(chatMessage).toBeUndefined();
            expect(mention!.title).toBe('Alice Test mentioned you in "Notification Chat"');
        });

        test('embedded chat uses comment-reply notification type', async () => {
            // Create a doc (which has an embedded chat)
            const doc = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}/create/doc`,
                { fileName: 'Comment Notify Doc' },
            );
            const docContents = await driveGet<DrivePath[]>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${doc.id}`,
            );
            const chatFolder = findOrFail(docContents, (item: DrivePath) => item.name === 'chat');
            const embeddedChat = await drivePost<DrivePath>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${chatFolder.id}/create/chat`,
                { fileName: 'General' },
            );

            // Share doc with Bob
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${doc.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: ctx.bob.user.email, read: true, write: true }] }),
                },
            );

            // Alice posts in the embedded chat
            await chatPost<ChatMessage>(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${embeddedChat.id}/messages`,
                { content: 'First comment' },
            );

            // Clear Bob's notifications
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}/mark-all-read`, {
                method: 'POST',
            });

            // Bob posts in the embedded chat — Alice should get comment-reply
            await chatPost<ChatMessage>(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `${embeddedChat.id}/messages`,
                { content: 'Reply comment' },
            );

            const res = await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`);
            const notifications = (await res.json()) as Notification[];
            const commentNotif = notifications.find((n) => !n.read && n.type === 'comment-reply');
            expect(commentNotif).toBeDefined();
            expect(commentNotif!.title).toBe('Bob Test commented on "Comment Notify Doc"');
            expect(commentNotif!.body).toBe('Reply comment');
            expect(commentNotif!.details).toEqual({ pathType: 'doc' });
        });
    });
});
