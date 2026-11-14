import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { orgOwnerId } from '@workspace/lib/types';
import type { Notification } from '@workspace/lib/types/notification';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { assertJson, authedRequest, driveDelete, driveGet, drivePost, eventually, getTestContext } from '../setup';

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

// Bob, or the caller `token` names, asking Alice for access to `pathId`.
function requestAccess(pathId: string, body: object = {}, token = ctx.bob.user.sessionToken): Promise<Response> {
    return authedRequest(token, `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${pathId}/request-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// sendMail stubbed; `toAlice()` lists the mails it was handed for Alice.
async function catchMail() {
    const mailer = await import('../../lib/mailer/mailer');
    const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
    spy.mockClear(); // spyOn returns a shared mock; reset call history per test
    return {
        spy,
        toAlice: () => spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === ctx.alice.user.email)),
    };
}

describe('Access-request email', () => {
    // Reset toggle before AND after each test — JsonStore is shared across the whole
    // suite, and the default for ownerOnAccessRequest is true.
    beforeEach(() => setToggle(true));
    afterEach(() => setToggle(true));

    test('emails owner when toggle on', async () => {
        const { spy, toAlice } = await catchMail();

        const doc = await createDoc('access-request-on');
        await requestAccess(doc.id, { message: 'Please' });

        const calls = await eventually(async () => (toAlice().length > 0 ? toAlice() : undefined), 'the mail');
        expect(calls.length).toBe(1);
        expect(calls[0][0].subject).toContain(ctx.bob.user.name);
        expect(calls[0][0].html).toContain('Please');
        spy.mockRestore();

        const notifs = await assertJson<Notification[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`),
        );
        const req = notifs.find(
            (n) => n.tag === `access-request:${ctx.alice.user.id}:${aliceMountId}:${doc.id}:${ctx.bob.user.email}`,
        );
        expect(req?.title).toBe(`${ctx.bob.user.name} requested access`);
        expect(req?.body).toBe('access-request-on');
        expect(req?.details).toEqual({ message: 'Please', pathType: 'doc' });
    });

    // The notification folds a repeat on its tag; the mail must not go out once per click either.
    test('a repeated request mails the owner once, while a request for another file still mails', async () => {
        const { spy, toAlice } = await catchMail();

        const doc = await createDoc('access-request-repeat');
        const other = await createDoc('access-request-repeat-other');
        for (let i = 0; i < 5; i++) await requestAccess(doc.id);
        await requestAccess(other.id);

        expect(
            await eventually(async () => (toAlice().length >= 2 ? toAlice() : undefined), 'both mails'),
        ).toHaveLength(2);
        spy.mockRestore();
    });

    test('a failed send leaves the next request free to mail again', async () => {
        const { spy, toAlice } = await catchMail();
        spy.mockResolvedValueOnce(false);

        const doc = await createDoc('access-request-failed-send');
        for (let i = 0; i < 3; i++) {
            await requestAccess(doc.id);
            await new Promise((r) => setTimeout(r, 50));
        }

        expect(toAlice().length).toBe(2);
        spy.mockRestore();
    });

    test('does not email when toggle off', async () => {
        await setToggle(false);
        const { spy, toAlice } = await catchMail();

        const doc = await createDoc('access-request-off');
        await requestAccess(doc.id);
        await new Promise((r) => setTimeout(r, 100));

        expect(toAlice().length).toBe(0);
        spy.mockRestore();
    });

    test('a missing or trashed path answers 200 and notifies and mails nobody', async () => {
        const { spy, toAlice } = await catchMail();
        const doc = await createDoc('access-request-trashed');
        await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${doc.id}`);

        expect((await requestAccess('no-such-path')).status).toBe(200);
        expect((await requestAccess(doc.id)).status).toBe(200);
        await new Promise((r) => setTimeout(r, 100));

        expect(toAlice().length).toBe(0);
        const notifs = await assertJson<Notification[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/notifications/${ctx.alice.user.id}`),
        );
        expect(notifs.filter((n) => n.tag?.includes(`:${doc.id}:`))).toHaveLength(0);
        spy.mockRestore();
    });

    test('an unknown mount, or the org, which has no drive, answers 404 and mails nobody', async () => {
        const { spy } = await catchMail();
        const doc = await createDoc('access-request-unknown-mount');
        const unknownMount = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/no-such-mount/path/${doc.id}/request-access`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        );
        const org = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${orgOwnerId(getServerConfig()!.orgId)}/${aliceMountId}/path/${doc.id}/request-access`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        );
        await new Promise((r) => setTimeout(r, 100));

        expect(unknownMount.status).toBe(404);
        expect(org.status).toBe(404);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    // Finding #15: the route accepted an unbounded message and any authenticated caller.
    test('rejects an oversized message with 422', async () => {
        const doc = await createDoc('access-request-huge');
        const res = await requestAccess(doc.id, { message: 'x'.repeat(100_000) });
        expect(res.status).toBe(422);
    });

    test('mails the address the owner has now, not the one their open Home started with', async () => {
        const { spy } = await catchMail();
        const doc = await createDoc('access-request-new-address');
        const newEmail = `renamed-${crypto.randomUUID()}@example.com`;
        const db = getAuthDrizzleDb();
        db.update(userSchema).set({ email: newEmail }).where(eq(userSchema.id, ctx.alice.user.id)).run();
        try {
            await requestAccess(doc.id);
            const toNew = () => spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === newEmail));
            expect(await eventually(async () => (toNew().length ? toNew() : undefined), 'the mail')).toHaveLength(1);
        } finally {
            db.update(userSchema)
                .set({ email: ctx.alice.user.email })
                .where(eq(userSchema.id, ctx.alice.user.id))
                .run();
            spy.mockRestore();
        }
    });

    test('rejects a guest caller with 403', async () => {
        const email = `access-req-guest-${crypto.randomUUID()}@external.com`;
        const password = crypto.randomUUID();
        const created = await auth.api.createUser({ body: { email, password, name: 'Guest Req', role: 'user' } });
        // Admin plugin only allows 'user'/'admin' via the API — demote directly to 'guest'.
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        const guestToken =
            (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';

        const doc = await createDoc('access-request-guest');
        const res = await requestAccess(doc.id, { message: 'let me in' }, guestToken);
        expect(res.status).toBe(403);
    });
});
