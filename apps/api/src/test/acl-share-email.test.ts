import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { authedRequest, driveGet, drivePost, drivePut, getTestContext } from './setup';

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

async function setAcl(pathId: string, acl: Array<{ id: string; read: boolean; write: boolean }>): Promise<void> {
    await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${pathId}/acl`, {
        acl,
        visibility: 'private',
    });
}

describe('ACL share email', () => {
    afterEach(async () => {
        await setEmailToggle('userOnAclAdd', false);
        await setEmailToggle('guestOnAclAdd', true);
    });

    test('does not email Eigen user when userOnAclAdd is off (default)', async () => {
        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);

        const doc = await createDoc('share-default-off');
        await setAcl(doc.id, [{ id: ctx.bob.user.email, read: true, write: false }]);
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });

    test('emails Eigen user when userOnAclAdd is on', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);

        const doc = await createDoc('share-toggle-on');
        await setAcl(doc.id, [{ id: ctx.bob.user.email, read: true, write: false }]);
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(1);
        expect(calls[0][0].subject).toContain(ctx.alice.user.name);
        spy.mockRestore();
    });

    test('does not email on permission upgrade (read → write)', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const doc = await createDoc('share-upgrade');
        await setAcl(doc.id, [{ id: ctx.bob.user.email, read: true, write: false }]);
        await new Promise((r) => setTimeout(r, 10));

        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);

        await setAcl(doc.id, [{ id: ctx.bob.user.email, read: true, write: true }]);
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });

    test('does not email on unshare', async () => {
        await setEmailToggle('userOnAclAdd', true);
        const doc = await createDoc('share-unshare');
        await setAcl(doc.id, [{ id: ctx.bob.user.email, read: true, write: true }]);
        await new Promise((r) => setTimeout(r, 10));

        const mailer = await import('../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);

        await setAcl(doc.id, []);
        await new Promise((r) => setTimeout(r, 10));

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });
});
