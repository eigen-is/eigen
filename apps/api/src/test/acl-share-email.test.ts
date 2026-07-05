import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Notification } from '@workspace/lib/types/notification';
import { assertJson, authedRequest, driveGet, drivePost, drivePut, getTestContext } from './setup';

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

async function setEmailToggle(key: 'guestOnAclAdd' | 'userOnAclAdd', value: boolean): Promise<void> {
    await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: { email: { [key]: value } } }),
    });
}

async function createDoc(name: string): Promise<{ id: string }> {
    return drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${aliceRootId}/create/doc`, {
        fileName: name,
    });
}

async function setAcl(
    pathId: string,
    delta: { add?: Array<{ id: string; read: boolean; write: boolean }>; remove?: string[] },
): Promise<void> {
    await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${pathId}/acl`, {
        ...delta,
        visibility: 'private',
    });
}

describe('ACL share email', () => {
    // Reset toggles before AND after each test — JsonStore is shared across the whole
    // suite, so we can't trust defaults coming in, and we mustn't leak state to other
    // test files. beforeEach guards entry, afterEach guards exit.
    async function resetToggles() {
        await setEmailToggle('userOnAclAdd', false);
        await setEmailToggle('guestOnAclAdd', true);
    }
    beforeEach(resetToggles);
    afterEach(resetToggles);

    test('does not email Eigen user when userOnAclAdd is off', async () => {
        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const doc = await createDoc('share-default-off');
        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });

    test('emails Eigen user when userOnAclAdd is on', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const doc = await createDoc('share-toggle-on');
        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(1);
        expect(calls[0][0].subject).toContain(ctx.alice.user.name);
        spy.mockRestore();
    });

    test('does not email on permission upgrade (read → write)', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const doc = await createDoc('share-upgrade');
        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });
        await new Promise((r) => setTimeout(r, 10));

        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });

    test('does not email on unshare', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const doc = await createDoc('share-unshare');
        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: true }] });
        await new Promise((r) => setTimeout(r, 10));

        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        await setAcl(doc.id, { remove: [ctx.bob.user.email] });
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });

    test('persists share + unshare notifications with the actor display name', async () => {
        const doc = await createDoc('share-notify');
        await setAcl(doc.id, { add: [{ id: ctx.bob.user.email, read: true, write: false }] });

        // The GET drains the async ACL fan-out before listing (authedRequest drains on entry).
        const shareList = await assertJson<Notification[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
        );
        const shared = shareList.find((n) => n.tag === `share:${ctx.alice.user.id}:${aliceMountId}:${doc.id}`);
        expect(shared?.title).toBe(`${ctx.alice.user.name} shared a doc`);
        expect(shared?.body).toBe('share-notify');
        expect(shared?.details).toEqual({ pathType: 'doc' });

        await setAcl(doc.id, { remove: [ctx.bob.user.email] });
        const unshareList = await assertJson<Notification[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
        );
        const unshared = unshareList.find((n) => n.type === 'unshare' && n.body === 'share-notify');
        expect(unshared?.title).toBe(`${ctx.alice.user.name} removed your access`);
        expect(unshared?.details).toEqual({ pathType: 'doc' });
    });
});
