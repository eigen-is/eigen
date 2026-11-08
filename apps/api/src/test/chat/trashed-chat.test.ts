import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessage, DrivePath } from '@workspace/lib/types';
import { assertJson, authedRequest, chatPost, driveGet, drivePost, drivePut, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

// A trashed chat refuses reads, and its restore brings its history back.
describe('A trashed chat', () => {
    let ctx: TestCtx;
    let chat: DrivePath;

    function getMessages(token: string): Promise<Response> {
        return authedRequest(token, `/chat/${ctx.alice.user.id}/${MOUNT}/${chat.id}/messages`);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const token = ctx.alice.user.sessionToken;
        const aliceId = ctx.alice.user.id;
        const rootId = (await driveGet<DrivePath>(token, aliceId, MOUNT, 'root')).id;
        chat = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}/create/chat`, {
            fileName: `trashed-chat-${crypto.randomUUID()}`,
        });
        await drivePut(token, aliceId, MOUNT, `path/${chat.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
        await chatPost(token, aliceId, MOUNT, `${chat.id}/messages`, { content: 'keep me' });
        await authedRequest(token, `/drive/${aliceId}/${MOUNT}/path/${chat.id}`, { method: 'DELETE' });
    });

    test('refuses the owner', async () => {
        expect((await getMessages(ctx.alice.user.sessionToken)).status).toBe(404);
    });

    test('refuses a sharee', async () => {
        expect((await getMessages(ctx.bob.user.sessionToken)).status).toBe(403);
    });

    test('restores with its history', async () => {
        const token = ctx.alice.user.sessionToken;
        await drivePost(token, ctx.alice.user.id, MOUNT, `trash/${chat.id}/restore`, {});
        const messages = await assertJson<ChatMessage[]>(await getMessages(token));
        expect(messages.map((m) => m.content)).toContain('keep me');
    });
});
