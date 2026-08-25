import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Notification } from '@workspace/lib/types/notification';
import { assertJson, authedRequest, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
let ctx: TestCtx;
let aliceMountId: string;
let aliceRootId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
    aliceMountId = mounts![0].id;
    const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
    aliceRootId = root.id;
});

async function setToggle(value: boolean) {
    await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: { email: { ownerOnAccessRequest: value } } }),
    });
}

async function createDoc(name: string): Promise<{ id: string }> {
    return drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${aliceRootId}/create/doc`, {
        fileName: name,
    });
}

describe('Access-request email', () => {
    // Reset toggle before AND after each test — JsonStore is shared across the whole
    // suite, and the default for ownerOnAccessRequest is true.
    beforeEach(() => setToggle(true));
    afterEach(() => setToggle(true));

    test('emails owner when toggle on', async () => {
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const doc = await createDoc('access-request-on');
        await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${doc.id}/request-access`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Please' }),
            },
        );
        await new Promise((r) => setTimeout(r, 100));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.alice.user.email));
        expect(calls.length).toBe(1);
        expect(calls[0][0].subject).toContain(ctx.bob.user.name);
        expect(calls[0][0].html).toContain('Please');
        spy.mockRestore();

        const notifs = await assertJson<Notification[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`),
        );
        const req = notifs.find((n) => n.type === 'access-request' && n.actorEmail === ctx.bob.user.email);
        expect(req?.title).toBe(`${ctx.bob.user.name} requested access`);
        expect(req?.body).toBe('access-request-on');
        expect(req?.details).toEqual({ message: 'Please', pathType: 'doc' });
    });

    test('does not email when toggle off', async () => {
        await setToggle(false);
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const doc = await createDoc('access-request-off');
        await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${doc.id}/request-access`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
        );
        await new Promise((r) => setTimeout(r, 100));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.alice.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });
});
