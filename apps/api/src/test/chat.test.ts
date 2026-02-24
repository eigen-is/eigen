import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(r => r.json());
}

function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/${parts.join('/')}`).then(r => r.json());
}

function chatPost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    }).then(r => r.json());
}

function chatGet(token: string, ownerId: string, mountId: string, path: string): Promise<any> {
    return authedRequest(token, `/chat/${ownerId}/${mountId}/${path}`).then(r => r.json());
}

describe('Chat', () => {
    let ctx: TestCtx;
    let aliceRootId: string;
    let aliceMountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const {data: mounts} = await ctx.alice.api.drive({ownerId: ctx.alice.user.id}).mounts.get();
        aliceMountId = mounts![0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    describe('Chat Creation', () => {
        let chatId: string;

        test('create chat', async () => {
            const data = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Team Chat'});
            expect(data.name).toBe('Team Chat.eigenchat');
            expect(data.type).toBe('chat');
            expect(data.mimeType).toBe('application/eigenchat');
            chatId = data.id;
        });

        test('chat appears in folder listing', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`);
            const chat = contents.find((item: any) => item.id === chatId);
            expect(chat).toBeDefined();
            expect(chat.type).toBe('chat');
        });

        test('chat has data.db and media subfolder', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${chatId}`);
            expect(Array.isArray(contents)).toBe(true);
            const dataDb = contents.find((item: any) => item.name === 'data.db');
            const media = contents.find((item: any) => item.name === 'media');
            expect(dataDb).toBeDefined();
            expect(media).toBeDefined();
            expect(media.type).toBe('folder');
        });
    });

    describe('Embedded Chat in Doc', () => {
        let docId: string;

        test('create doc creates chat/ subfolder with General chat', async () => {
            const doc = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/doc`, {fileName: 'Test Doc'});
            docId = doc.id;

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${docId}`);
            const chatFolder = contents.find((item: any) => item.name === 'chat');
            expect(chatFolder).toBeDefined();
            expect(chatFolder.type).toBe('folder');

            const chatContents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${chatFolder.id}`);
            const generalChat = chatContents.find((item: any) => item.name === 'General.eigenchat');
            expect(generalChat).toBeDefined();
            expect(generalChat.type).toBe('chat');

            const chatInternals = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${generalChat.id}`);
            const dataDb = chatInternals.find((item: any) => item.name === 'data.db');
            expect(dataDb).toBeDefined();
        });
    });

    describe('Messages', () => {
        let chatId: string;
        let messageId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Message Test Chat'});
            chatId = chat.id;
        });

        test('post message', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'Hello, world!'});
            expect(data.id).toBeDefined();
            expect(data.content).toBe('Hello, world!');
            expect(data.type).toBe('message');
            expect(data.authorId).toBe(ctx.alice.user.id);
            expect(data.authorEmail).toBe(ctx.alice.user.email);
            messageId = data.id;
        });

        test('get messages returns posted message', async () => {
            const data = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(1);
            expect(data[0].content).toBe('Hello, world!');
        });

        test('post emote message', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'waves', type: 'emote'});
            expect(data.type).toBe('emote');
            expect(data.content).toBe('waves');
        });

        test('edit message', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${messageId}`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: 'Hello, edited!'}),
                });
            const data = await res.json() as any;
            expect(data.success).toBe(true);
            expect(data.message.content).toBe('Hello, edited!');
            expect(data.message.editedAt).toBeDefined();
        });

        test('delete message (soft delete)', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${messageId}`, {
                    method: 'DELETE',
                });
            const data = await res.json() as any;
            expect(data.success).toBe(true);
        });

        test('mark as read', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const lastMsg = msgs[msgs.length - 1];

            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/read`, {messageId: lastMsg.id});
            expect(data.success).toBe(true);
        });

        test('reply to message', async () => {
            const original = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'Original message'});

            const reply = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'This is a reply', replyTo: original.id});
            expect(reply.replyTo).toBe(original.id);
        });
    });

    describe('Whisper Visibility', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Whisper Test Chat'});
            chatId = chat.id;

            const BOB_EMAIL = 'bob@test.eigen.is';
            const CHARLIE_EMAIL = 'charlie@test.eigen.is';
            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [
                            {email: BOB_EMAIL, read: true, write: true, public: false},
                            {email: CHARLIE_EMAIL, read: true, write: true, public: false},
                        ],
                    }),
                });
        });

        test('Alice whispers to Bob', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {
                    content: 'Secret message for Bob only',
                    type: 'whisper',
                    whisperTo: ctx.bob.user.id,
                });
            expect(msg.type).toBe('whisper');
            expect(msg.whisperTo).toBe(ctx.bob.user.id);
            expect(msg.content).toBe('Secret message for Bob only');
        });

        test('Alice posts a normal message', async () => {
            await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'Public message from Alice'});
        });

        test('Alice sees whisper content (she is the author)', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toContain('whispers to');
            expect(whisper.content).toContain('Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.id);
        });

        test('Bob sees whisper content (he is the recipient)', async () => {
            const msgs = await chatGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toBe('whispers to you: Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.id);
        });

        test('Charlie sees whisper exists but content is hidden', async () => {
            const msgs = await chatGet(ctx.charlie.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toContain('[a few hushed words]');
            expect(whisper.whisperTo).toBeNull();
        });

        test('Charlie sees normal messages normally', async () => {
            const msgs = await chatGet(ctx.charlie.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const normal = msgs.find((m: any) => m.type === 'message');
            expect(normal).toBeDefined();
            expect(normal.content).toBe('Public message from Alice');
        });
    });

    describe('Attachments', () => {
        let chatId: string;
        let mediaFolderId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Attachment Test Chat'});
            chatId = chat.id;

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${chatId}`);
            const media = contents.find((item: any) => item.name === 'media');
            mediaFolderId = media.id;
        });

        test('upload file to media and post message with attachment', async () => {
            const file = new File(['attachment content'], 'test-attachment.txt', {type: 'text/plain'});
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${mediaFolderId}`, {
                    method: 'POST',
                    body: formData,
                });
            const uploaded = await uploadRes.json() as any;
            expect(uploaded.id).toBeDefined();
            expect(uploaded.name).toBe('test-attachment.txt');

            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'Message with attachment', attachments: [uploaded.id]});
            expect(msg.id).toBeDefined();
            expect(msg.content).toBe('Message with attachment');
            expect(msg.attachments).toEqual([uploaded.id]);
        });

        test('get messages returns attachment pathIds', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const withAttachment = msgs.find((m: any) => m.attachments && m.attachments.length > 0);
            expect(withAttachment).toBeDefined();
            expect(withAttachment.attachments.length).toBe(1);
        });

        test('deleting message also deletes attachment file', async () => {
            const file = new File(['delete-me'], 'delete-me.txt', {type: 'text/plain'});
            const formData = new FormData();
            formData.append('file', file);
            const uploadRes = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${mediaFolderId}`, {
                    method: 'POST',
                    body: formData,
                });
            const uploaded = await uploadRes.json() as any;
            const attachmentId = uploaded.id;

            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'Will be deleted', attachments: [attachmentId]});

            const deleteRes = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages/${msg.id}`, {
                    method: 'DELETE',
                });
            const deleteData = await deleteRes.json() as any;
            expect(deleteData.success).toBe(true);

            const mediaContents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${mediaFolderId}`);
            const deletedFile = mediaContents.find((item: any) => item.id === attachmentId);
            expect(deletedFile).toBeUndefined();
        });
    });

    describe('Slash Commands', () => {
        let chatId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Slash Command Chat'});
            chatId = chat.id;

            await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${chatId}/acl`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        acl: [
                            {email: 'bob@test.eigen.is', read: true, write: true, public: false},
                        ],
                    }),
                });
        });

        test('/dance creates built-in emote', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/dance'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('$dance');
        });

        test('/cheer creates built-in emote', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/cheer'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('$cheer');
        });

        test('/taunt creates built-in emote', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/taunt'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('$taunt');
        });

        test('/greet creates built-in emote', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/greet'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('$greet');
        });

        test('/me creates custom emote', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/me tips hat'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('tips hat');
        });

        test('emote first person for author', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const dance = msgs.find((m: any) => m.type === 'emote' && m.content === 'You dance around the room.');
            expect(dance).toBeDefined();
        });

        test('emote third person for other user', async () => {
            const msgs = await chatGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const dance = msgs.find((m: any) => m.type === 'emote' && m.content.includes('dances around the room.'));
            expect(dance).toBeDefined();
        });

        test('custom emote formatted with author name for other user', async () => {
            const msgs = await chatGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const me = msgs.find((m: any) => m.type === 'emote' && m.content.includes('tips hat'));
            expect(me).toBeDefined();
            expect(me.content).toContain(ctx.alice.user.email.split('@')[0]);
        });

        test('/whisper creates whisper message', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: `/whisper ${ctx.bob.user.email} secret hello`});
            expect(msg.type).toBe('whisper');
            expect(msg.whisperTo).toBe(ctx.bob.user.email);
            expect(msg.content).toBe('secret hello');
        });

        test('/w alias works for whisper', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: `/w ${ctx.bob.user.email} short whisper`});
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('short whisper');
        });

        test('/tell alias works for whisper', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: `/tell ${ctx.bob.user.email} tell msg`});
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('tell msg');
        });

        test('/t alias works for whisper', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: `/t ${ctx.bob.user.email} t msg`});
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('t msg');
        });

        test('/send alias works for whisper', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: `/send ${ctx.bob.user.email} send msg`});
            expect(msg.type).toBe('whisper');
            expect(msg.content).toBe('send msg');
        });

        test('whisper to non-existent user returns error', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: '/whisper nobody@fake.eigen.is hello'}),
                });
            expect(res.status).toBe(404);
        });

        test('whisper to non-existent user does not create a message', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const leaked = msgs.find((m: any) => m.content === 'hello' && m.whisperTo === 'nobody@fake.eigen.is');
            expect(leaked).toBeUndefined();
        });

        test('whisper via type field to non-existent user returns error', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/messages`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({content: 'direct whisper', type: 'whisper', whisperTo: 'ghost@fake.eigen.is'}),
                });
            expect(res.status).toBe(404);
        });

        test('Bob sees whisper sent via /whisper command', async () => {
            const msgs = await chatGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper' && m.content === 'whispers to you: secret hello');
            expect(whisper).toBeDefined();
            expect(whisper.whisperTo).toBe(ctx.bob.user.email);
        });

        test('regular text starting with / but not a command posts as message', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: '/unknown command here'});
            expect(msg.type).toBe('message');
            expect(msg.content).toBe('/unknown command here');
        });

        test('explicit type overrides command parsing', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/messages`, {content: 'explicit emote', type: 'emote'});
            expect(msg.type).toBe('emote');
            expect(msg.content).toBe('explicit emote');
        });
    });

    describe('Delete Chat', () => {
        test('create and delete chat', async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Deletable Chat'});

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${chat.id}`, {method: 'DELETE'});
            const data = await res.json() as any;
            expect(data.success).toBe(true);

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`);
            const deleted = contents.find((item: any) => item.id === chat.id);
            expect(deleted).toBeUndefined();
        });
    });
});
