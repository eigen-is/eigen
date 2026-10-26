import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, DrivePath } from '@workspace/lib/types';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount';
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

const MOUNT = 'default';

// A read of a trashed chat must not create a new data.db inside it. A live one there would take the
// trashed one's name, and the restore would then fail on the unique name index.
describe('A trashed chat', () => {
    let ctx: TestCtx;
    let chat: DrivePath;
    let mount: Mount;

    function getMessages(token: string): Promise<Response> {
        return authedRequest(token, `/chat/${ctx.alice.user.id}/${MOUNT}/${chat.id}/messages`);
    }

    async function liveChildren(): Promise<string[]> {
        return (await mount.listFolderAll(chat.id)).filter((p) => !p.trashedAt).map((p) => p.name);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const token = ctx.alice.user.sessionToken;
        const aliceId = ctx.alice.user.id;
        const rootId = (await driveGet<DrivePath>(token, aliceId, MOUNT, 'root')).id;
        chat = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}/create/chat`, {
            fileName: `trashed-chat-${randomUUID()}`,
        });
        await drivePut(token, aliceId, MOUNT, `path/${chat.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
        await chatPost(token, aliceId, MOUNT, `${chat.id}/messages`, { content: 'keep me' });
        mount = findOrFail((await getHome(aliceId)).drive.getMounts(), (m) => m.id === MOUNT);
        await authedRequest(token, `/drive/${aliceId}/${MOUNT}/path/${chat.id}`, { method: 'DELETE' });
    });

    test('refuses the owner and creates nothing inside it', async () => {
        expect((await getMessages(ctx.alice.user.sessionToken)).status).toBe(404);
        expect(await liveChildren()).toEqual([]);
    });

    test('refuses a sharee and creates nothing inside it', async () => {
        expect((await getMessages(ctx.bob.user.sessionToken)).status).toBe(404);
        expect(await liveChildren()).toEqual([]);
    });

    test('restores with its history', async () => {
        const token = ctx.alice.user.sessionToken;
        await drivePost(token, ctx.alice.user.id, MOUNT, `trash/${chat.id}/restore`, {});
        const messages = await assertJson<ChatMessage[]>(await getMessages(token));
        expect(messages.map((m) => m.content)).toContain('keep me');
    });
});
