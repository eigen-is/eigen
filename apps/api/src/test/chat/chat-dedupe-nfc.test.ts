import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { assertJson, authedRequest, firstMountId, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// Same rule as the drive copy route: the dedup compare runs in NFC, the form the store keeps names in.
describe('chat rooms dedupeName normalizes to NFC', () => {
    let ctx: TestCtx;
    let mountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
    });

    async function createRoom(fileName: string): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/chat/${ctx.alice.user.id}/${mountId}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, members: [ctx.bob.user.email], dedupeName: true }),
        });
    }

    test('a decomposed spelling of an existing room name gets the (2) suffix', async () => {
        const first = await assertJson<DrivePath>(await createRoom('Café chat'));
        expect(first.name).toBe('Café chat.eigenchat');
        const second = await assertJson<DrivePath>(await createRoom('Café chat'.normalize('NFD')));
        expect(second.name).toBe('Café chat (2).eigenchat');
    });
});
