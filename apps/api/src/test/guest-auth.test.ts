import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DrivePath } from '@workspace/lib/types';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../auth-schema.ts';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { updateServerConfig } from '../lib/config/server-config';
import { assertJson, authedRequest, getTestContext } from './setup';

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

    test('request-otp rejects email with no shares', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'nobody@example.com' }),
            }),
        );
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(body).toContain('No shared resources found');
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
                        acl: [{ id: guestEmail, read: true, write: false }],
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
});
