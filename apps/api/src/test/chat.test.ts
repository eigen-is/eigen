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

    describe('Chat & Room Creation', () => {
        let chatId: string;
        let roomId: string;

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

        test('create room in chat', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms`, {roomName: 'general'});
            expect(data.name).toBe('general.eigenchatroom');
            expect(data.type).toBe('chatroom');
            expect(data.mimeType).toBe('application/eigenchatroom');
            roomId = data.id;
        });

        test('room has data.db and media subfolder', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${roomId}`);
            expect(Array.isArray(contents)).toBe(true);
            const dataDb = contents.find((item: any) => item.name === 'data.db');
            const media = contents.find((item: any) => item.name === 'media');
            expect(dataDb).toBeDefined();
            expect(media).toBeDefined();
            expect(media.type).toBe('folder');
        });

        test('room appears in chat folder listing', async () => {
            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${chatId}`);
            const room = contents.find((item: any) => item.id === roomId);
            expect(room).toBeDefined();
            expect(room.type).toBe('chatroom');
        });

        test('create second room', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms`, {roomName: 'random'});
            expect(data.name).toBe('random.eigenchatroom');
        });
    });

    describe('Messages', () => {
        let chatId: string;
        let roomId: string;
        let messageId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Message Test Chat'});
            chatId = chat.id;

            const room = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms`, {roomName: 'messages'});
            roomId = room.id;
        });

        test('post message', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`, {content: 'Hello, world!'});
            expect(data.id).toBeDefined();
            expect(data.content).toBe('Hello, world!');
            expect(data.type).toBe('message');
            expect(data.authorId).toBe(ctx.alice.user.id);
            expect(data.authorEmail).toBe(ctx.alice.user.email);
            messageId = data.id;
        });

        test('get messages returns posted message', async () => {
            const data = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(1);
            expect(data[0].content).toBe('Hello, world!');
        });

        test('post emote message', async () => {
            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`, {content: 'waves', type: 'emote'});
            expect(data.type).toBe('emote');
            expect(data.content).toBe('waves');
        });

        test('edit message', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/rooms/${roomId}/messages/${messageId}`, {
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
                `/chat/${ctx.alice.user.id}/${aliceMountId}/${chatId}/rooms/${roomId}/messages/${messageId}`, {
                    method: 'DELETE',
                });
            const data = await res.json() as any;
            expect(data.success).toBe(true);
        });

        test('mark as read', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            const lastMsg = msgs[msgs.length - 1];

            const data = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/read`, {messageId: lastMsg.id});
            expect(data.success).toBe(true);
        });

        test('reply to message', async () => {
            const original = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`, {content: 'Original message'});

            const reply = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`, {content: 'This is a reply', replyTo: original.id});
            expect(reply.replyTo).toBe(original.id);
        });
    });

    describe('Whisper Visibility', () => {
        let chatId: string;
        let roomId: string;

        beforeAll(async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Whisper Test Chat'});
            chatId = chat.id;

            // Share chat with Bob and Charlie (read+write)
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

            const room = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms`, {roomName: 'whispers'});
            roomId = room.id;
        });

        test('Alice whispers to Bob', async () => {
            const msg = await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`, {
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
                `${chatId}/rooms/${roomId}/messages`, {content: 'Public message from Alice'});
        });

        test('Alice sees whisper content (she is the author)', async () => {
            const msgs = await chatGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toBe('Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.id);
        });

        test('Bob sees whisper content (he is the recipient)', async () => {
            const msgs = await chatGet(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toBe('Secret message for Bob only');
            expect(whisper.whisperTo).toBe(ctx.bob.user.id);
        });

        test('Charlie sees whisper exists but content is hidden', async () => {
            const msgs = await chatGet(ctx.charlie.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            const whisper = msgs.find((m: any) => m.type === 'whisper');
            expect(whisper).toBeDefined();
            expect(whisper.content).toBe('');
            expect(whisper.whisperTo).toBeNull();
        });

        test('Charlie sees normal messages normally', async () => {
            const msgs = await chatGet(ctx.charlie.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms/${roomId}/messages`);
            const normal = msgs.find((m: any) => m.type === 'message');
            expect(normal).toBeDefined();
            expect(normal.content).toBe('Public message from Alice');
        });
    });

    describe('Delete Chat', () => {
        let chatId: string;

        test('create and delete chat', async () => {
            const chat = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}/chat`, {fileName: 'Deletable Chat'});
            chatId = chat.id;

            await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `${chatId}/rooms`, {roomName: 'temp'});

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${aliceMountId}/folder/${chatId}`, {method: 'DELETE'});
            const data = await res.json() as any;
            expect(data.success).toBe(true);

            const contents = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`);
            const deleted = contents.find((item: any) => item.id === chatId);
            expect(deleted).toBeUndefined();
        });
    });
});
