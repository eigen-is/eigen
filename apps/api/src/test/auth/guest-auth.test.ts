import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types';
import { eq } from 'drizzle-orm';
import { user as userSchema, verification as verificationSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { _resetOtpRateLimitForTests } from '../../lib/auth/otp-rate-limit';
import { updateServerConfig } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { assertJson, authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Guest Auth', () => {
    let ctx: TestCtx;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        // Make sendMail skip so request-otp can return 200 in tests
        await updateServerConfig({ domain: 'localhost' });

        const rootRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/root`);
        const root = await assertJson<DrivePath>(rootRes);
        aliceRootId = root.id;
    });

    afterAll(async () => {
        await updateServerConfig({ domain: 'test.eigen.is' });
    });

    beforeEach(() => {
        _resetOtpRateLimitForTests();
    });

    describe('open signup setting', () => {
        afterAll(async () => {
            await updateServerSettings({ guests: { openSignup: true } });
        });

        test('open signup accepts unknown email', async () => {
            await updateServerSettings({ guests: { openSignup: true } });
            const res = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: `open-${randomUUID()}@example.com` }),
                }),
            );
            expect(res.status).toBe(200);
        });

        test('closed signup rejects unknown email', async () => {
            await updateServerSettings({ guests: { openSignup: false } });
            const res = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: `closed-${randomUUID()}@example.com` }),
                }),
            );
            expect(res.status).toBe(400);
            expect(await res.text()).toContain('No shared resources found');
        });
    });

    test('request-otp rejects existing non-guest user', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: ctx.alice.user.email }),
            }),
        );
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(body).toContain('Use password login');
    });

    test('request-otp returns 429 after exceeding the per-email rate limit', async () => {
        const email = `rl-${randomUUID()}@example.com`;
        for (let i = 0; i < 3; i++) {
            const ok = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                }),
            );
            expect(ok.status).toBe(200);
        }
        const res = await ctx.app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            }),
        );
        expect(res.status).toBe(429);
        expect(await res.text()).toContain('Too many');
    });

    test('request-otp rejects an over-length email with 422', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: `${'a'.repeat(300)}@example.com` }),
            }),
        );
        // maxLength violation → Elysia validation error, before the limiter keys a bucket by it.
        expect(res.status).toBe(422);
    });

    describe('request-otp and verify-otp flow', () => {
        const guestEmail = 'guest@external.com';

        beforeAll(async () => {
            // Create a folder and share it with the guest email so request-otp can succeed
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: 'guest-shared' }),
                },
            );
            const folder = await assertJson<DrivePath>(folderRes);

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        add: [{ id: guestEmail, read: true, write: false }],
                    }),
                },
            );
        });

        test('request-otp succeeds for email with shares', async () => {
            const res = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: guestEmail }),
                }),
            );
            expect(res.status).toBe(200);
        });

        test('verify-otp rejects wrong code', async () => {
            const res = await ctx.app.handle(
                new Request('http://localhost/guest-auth/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: guestEmail, otp: '000000' }),
                }),
            );
            expect(res.status).toBe(400);
        });
    });

    describe('Guest user route guards', () => {
        let guestUserId: string;
        let guestToken: string;

        beforeAll(async () => {
            const email = `guard-guest-${randomUUID()}@external.com`;
            const password = randomUUID();

            const created = await auth.api.createUser({
                body: {
                    email,
                    password,
                    name: 'Test Guest',
                    role: 'user',
                },
            });
            guestUserId = created.user.id;
            // Set to 'guest' directly — admin plugin only allows 'user'/'admin' via API
            getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, guestUserId)).run();

            // Sign in to get a properly signed session cookie
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email, password },
            });
            const setCookie = signIn.headers.get('set-cookie') || '';
            const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
            guestToken = match?.[1] ?? '';
        });

        test('guest cannot access mail routes', async () => {
            const res = await authedRequest(guestToken, `/mail/${guestUserId}/mailboxes`);
            expect(res.status).toBe(403);
        });

        test('guest cannot access contacts routes', async () => {
            const res = await authedRequest(guestToken, `/contacts/${guestUserId}/contacts`);
            expect(res.status).toBe(403);
        });

        test('guest cannot access calendar routes', async () => {
            const res = await authedRequest(guestToken, `/calendar/${guestUserId}/calendars`);
            expect(res.status).toBe(403);
        });

        test('guest cannot access space routes', async () => {
            const res = await authedRequest(guestToken, `/space/${guestUserId}/settings`);
            expect(res.status).toBe(403);
        });
    });

    describe('persistent share registry', () => {
        test('reconciliation does not consume registry entries', async () => {
            const { addRegistryEntry, getEntriesForTarget } = await import('../../lib/share/registry');
            const { reconcileSharesForNewUser } = await import('../../lib/share');
            const { getUserByEmail } = await import('../../lib/user/user');

            const guestEmail = `reg-keep-${randomUUID()}@example.com`;
            await addRegistryEntry(ctx.alice.user.id, guestEmail);
            expect(await getEntriesForTarget(guestEmail)).toContain(ctx.alice.user.id);

            const created = await auth.api.createUser({
                body: { email: guestEmail, password: randomUUID(), name: 'Reg Keep', role: 'user' },
            });
            getAuthDrizzleDb()
                .update(userSchema)
                .set({ role: 'guest' })
                .where(eq(userSchema.id, created.user.id))
                .run();
            const guestUser = await getUserByEmail(guestEmail);
            if (!guestUser) throw new Error('test setup');

            await reconcileSharesForNewUser(guestUser);

            expect(await getEntriesForTarget(guestEmail)).toContain(ctx.alice.user.id);
        });

        test('deleting a guest preserves registry entries', async () => {
            const { addRegistryEntry, getEntriesForTarget } = await import('../../lib/share/registry');

            const guestEmail = `reg-survive-${randomUUID()}@example.com`;
            await addRegistryEntry(ctx.alice.user.id, guestEmail);

            const created = await auth.api.createUser({
                body: { email: guestEmail, password: randomUUID(), name: 'Reg Survive', role: 'user' },
            });
            getAuthDrizzleDb()
                .update(userSchema)
                .set({ role: 'guest' })
                .where(eq(userSchema.id, created.user.id))
                .run();

            const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${created.user.id}`, {
                method: 'DELETE',
            });
            expect(res.status).toBe(200);

            expect(await getEntriesForTarget(guestEmail)).toContain(ctx.alice.user.id);
        });
    });

    describe('full guest flow (request-otp → verify-otp → access)', () => {
        let folderId: string;
        const guestEmail = `flow-${randomUUID()}@external.com`;

        beforeAll(async () => {
            // Alice shares a folder with the guest email so request-otp can succeed.
            const folderRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: `flow-shared-${randomUUID()}` }),
                },
            );
            const folder = await assertJson<DrivePath>(folderRes);
            folderId = folder.id;

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: guestEmail, read: true, write: false }] }),
                },
            );
        });

        async function requestOtpAndCapture(email: string): Promise<string> {
            const mailer = await import('../../lib/core/mailer');
            const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
            spy.mockClear();
            const res = await ctx.app.handle(
                new Request('http://localhost/guest-auth/request-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                }),
            );
            expect(res.status).toBe(200);
            const otpCall = spy.mock.calls.find((c) => c[0].to.some((t) => t.address === email));
            if (!otpCall) throw new Error('OTP email not sent');
            const text = otpCall[0].text;
            const match = text.match(/\b(\d{6})\b/);
            if (!match) throw new Error(`OTP not found in email body: ${text}`);
            spy.mockRestore();
            return match[1]!;
        }

        function extractSessionTokenFromResponse(res: Response): string {
            const setCookie = res.headers.get('set-cookie') || '';
            const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
            if (!match) throw new Error(`No session cookie: ${setCookie}`);
            return match[1]!;
        }

        async function verifyOtp(email: string, otp: string): Promise<Response> {
            return ctx.app.handle(
                new Request('http://localhost/guest-auth/verify-otp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, otp }),
                }),
            );
        }

        test('a wrong guess consumes the code — a later correct attempt fails', async () => {
            const otp = await requestOtpAndCapture(guestEmail);
            // The code row is deleted before the async verify, so even a wrong guess consumes it...
            const wrong = await verifyOtp(guestEmail, otp === '000000' ? '111111' : '000000');
            expect(wrong.status).toBe(400);
            // ...and the real code no longer works (one code can't be retried or double-spent).
            const retry = await verifyOtp(guestEmail, otp);
            expect(retry.status).toBe(400);
        });

        test('end-to-end: guest can hit /events, /notifications, and sees shared item in /shared/with-me', async () => {
            const otp = await requestOtpAndCapture(guestEmail);
            const verifyRes = await verifyOtp(guestEmail, otp);
            expect(verifyRes.status).toBe(200);

            const guestUserRow = getAuthDrizzleDb()
                .select()
                .from(userSchema)
                .where(eq(userSchema.email, guestEmail))
                .get();
            if (!guestUserRow) throw new Error('guest user not created');
            const guestId = guestUserRow.id;

            // Regression test for the parseOwnerId bug — guest ids must be 32-char alphanumeric.
            expect(guestId).toMatch(/^[0-9A-Za-z]{32}$/);

            const guestToken = extractSessionTokenFromResponse(verifyRes);

            // /notifications must not 404 — getHome(guestId) needs parseOwnerId to accept the id.
            const notifRes = await authedRequest(guestToken, `/notifications/${guestId}`);
            expect(notifRes.status).toBe(200);

            // /events SSE — opens a long-lived stream; only assert headers came back as 200.
            // The body is consumed in the background by Elysia until the test exits.
            const sseRes = await authedRequest(guestToken, `/sse/${guestId}/events`);
            expect(sseRes.status).toBe(200);
            await sseRes.body?.cancel();

            // Shared folder must appear in /shared/with-me.
            const sharedRes = await authedRequest(guestToken, `/drive/${guestId}/shared/with-me`);
            const shared = await assertJson<DrivePath[]>(sharedRes);
            expect(shared.some((p) => p.id === folderId)).toBe(true);
        });

        test('reconciliation runs on second login too (recovery from any first-time failure)', async () => {
            // Fresh email so the second login below is the second OTP for THIS email.
            const email = `relogin-${randomUUID()}@external.com`;

            // Pre-share a different folder to this email.
            const folder2Res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/folder/${aliceRootId}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderName: `relogin-${randomUUID()}` }),
                },
            );
            const folder2 = await assertJson<DrivePath>(folder2Res);
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/default/path/${folder2.id}/acl`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ add: [{ id: email, read: true, write: false }] }),
                },
            );

            // First login.
            const otp1 = await requestOtpAndCapture(email);
            const verify1 = await verifyOtp(email, otp1);
            expect(verify1.status).toBe(200);
            const guestId = getAuthDrizzleDb().select().from(userSchema).where(eq(userSchema.email, email)).get()!.id;

            // Wipe the guest's shared_paths cache to simulate a first-login that did NOT
            // reconcile (the bug we just fixed). Then assert second login restores it.
            const { getHome } = await import('../../lib/home/get-home');
            const home = await getHome(guestId);
            // biome-ignore lint/suspicious/noExplicitAny: test reaches into private state on purpose
            const sharedDb = (home.drive as any).sharedDb as ReturnType<typeof getAuthDrizzleDb>;
            const { sharedPaths } = await import('../../lib/drive/sharedschema');
            sharedDb.delete(sharedPaths).run();

            // Second login.
            _resetOtpRateLimitForTests();
            const otp2 = await requestOtpAndCapture(email);
            const verify2 = await verifyOtp(email, otp2);
            expect(verify2.status).toBe(200);

            const guestToken = extractSessionTokenFromResponse(verify2);
            const sharedRes = await authedRequest(guestToken, `/drive/${guestId}/shared/with-me`);
            const shared = await assertJson<DrivePath[]>(sharedRes);
            expect(shared.some((p) => p.id === folder2.id)).toBe(true);
        });

        test('concurrent request-otp does not produce duplicate verification rows', async () => {
            const email = `race-${randomUUID()}@external.com`;
            await updateServerSettings({ guests: { openSignup: true } });

            // Fire N concurrent request-otp calls. Without the fix (delete + await + insert),
            // multiple rows can survive in the verification table because each request
            // deletes the row that's about to be inserted by the previous one.
            await Promise.all(
                Array.from({ length: 5 }, () =>
                    ctx.app.handle(
                        new Request('http://localhost/guest-auth/request-otp', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email }),
                        }),
                    ),
                ),
            );

            const rows = getAuthDrizzleDb()
                .select()
                .from(verificationSchema)
                .where(eq(verificationSchema.identifier, `guest-otp:${email}`))
                .all();
            expect(rows.length).toBe(1);
        });
    });

    describe('guest deletion', () => {
        test('deleting a guest user removes their data directory', async () => {
            const { existsSync } = await import('node:fs');
            const { getGuestHomePath } = await import('../../lib/config/paths');

            // Create a guest user with a home directory
            const guestEmail = 'delete-test-guest@external.com';
            const password = crypto.randomUUID();
            const created = await auth.api.createUser({
                body: { email: guestEmail, password, name: 'Delete Test', role: 'user' },
            });
            const guestId = created.user.id;
            getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, guestId)).run();

            // Initialize GuestHome so the data directory is created
            const { getHome, evictHome } = await import('../../lib/home/get-home');
            const home = await getHome(guestId);
            expect(home).toBeTruthy();
            await evictHome(guestId);

            const guestDir = getGuestHomePath(guestId);
            expect(existsSync(guestDir)).toBe(true);

            // Delete the guest via the admin endpoint
            const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${guestId}`, {
                method: 'DELETE',
            });
            expect(res.status).toBe(200);

            expect(existsSync(guestDir)).toBe(false);
        });
    });
});
