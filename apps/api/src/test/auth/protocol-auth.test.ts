import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { app, getTestContext } from '../setup';

describe('Protocol Auth', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let verifyProtocolAuth: typeof import('../../lib/auth/protocol-auth').verifyProtocolAuth;
    let auth: typeof import('../../lib/auth/auth').auth;
    let resetProtocolAuthLimit: typeof import('../../lib/auth/protocol-rate-limit')._resetProtocolAuthLimitForTests;

    beforeAll(async () => {
        ctx = await getTestContext();
        verifyProtocolAuth = (await import('../../lib/auth/protocol-auth')).verifyProtocolAuth;
        auth = (await import('../../lib/auth/auth')).auth;
        resetProtocolAuthLimit = (await import('../../lib/auth/protocol-rate-limit'))._resetProtocolAuthLimitForTests;
    });

    // Isolate the shared in-memory failure limiter so no test's failures leak into the next.
    beforeEach(() => resetProtocolAuthLimit?.());

    test('rejects unknown email', async () => {
        await expect(verifyProtocolAuth('nobody@test.eigen.is', 'anything')).rejects.toThrow();
    });

    test('rejects wrong password', async () => {
        await expect(verifyProtocolAuth(ctx.alice.user.email, 'wrongpassword')).rejects.toThrow();
    });

    test('accepts correct primary password', async () => {
        const user = await verifyProtocolAuth(ctx.alice.user.email, 'testpassword123');
        expect(user.id).toBe(ctx.alice.user.id);
        expect(user.email).toBe(ctx.alice.user.email);
    });

    test('accepts valid app password', async () => {
        const created = await auth.api.createApiKey({
            body: { name: 'test-app-password' },
            headers: {
                cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}`,
            },
        });
        expect(created?.key).toBeDefined();

        const user = await verifyProtocolAuth(ctx.alice.user.email, created!.key!);
        expect(user.id).toBe(ctx.alice.user.id);
    });

    test('rejects app password for wrong user', async () => {
        const created = await auth.api.createApiKey({
            body: { name: 'test-wrong-user' },
            headers: {
                cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}`,
            },
        });

        await expect(verifyProtocolAuth(ctx.bob.user.email, created!.key!)).rejects.toThrow();
    });

    test('internal auth endpoint accepts correct password', async () => {
        const res = await app.handle(
            new Request('http://localhost/internal/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: ctx.alice.user.email,
                    password: 'testpassword123',
                }),
            }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.userId).toBe(ctx.alice.user.id);
    });

    test('internal auth endpoint rejects wrong password', async () => {
        const res = await app.handle(
            new Request('http://localhost/internal/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: ctx.alice.user.email,
                    password: 'wrongpassword',
                }),
            }),
        );
        expect(res.status).toBe(401);
    });

    test('CalDAV basic auth accepts correct password', async () => {
        const res = await app.handle(
            new Request('http://localhost/dav/', {
                method: 'PROPFIND',
                headers: {
                    Authorization: `Basic ${btoa(`${ctx.alice.user.email}:testpassword123`)}`,
                    Depth: '0',
                },
            }),
        );
        expect(res.status).toBe(207);
    });

    test('CalDAV basic auth rejects wrong password', async () => {
        const res = await app.handle(
            new Request('http://localhost/dav/', {
                method: 'PROPFIND',
                headers: {
                    Authorization: `Basic ${btoa(`${ctx.alice.user.email}:wrongpassword`)}`,
                    Depth: '0',
                },
            }),
        );
        expect(res.status).toBe(401);
    });

    // -- 2FA hard-gate: primary password must never bypass 2FA over protocol auth --

    describe('2FA-enabled accounts', () => {
        const email = 'twofa-protocol@test.eigen.is';
        const primaryPassword = 'testpassword123';
        let userId: string;
        let appPassword: string;

        beforeAll(async () => {
            // Dedicated user so we never leak 2FA state into ctx.alice/ctx.bob.
            const { getAuthDrizzleDb } = await import('../../lib/auth/auth');
            const { getUserByEmail } = await import('../../lib/user');
            const { user } = await import('../../../auth-schema');
            const { eq } = await import('drizzle-orm');

            try {
                await auth.api.signUpEmail({ body: { email, password: primaryPassword, name: 'TwoFA User' } });
            } catch {
                // Already created by an earlier run sharing this process' DB.
            }

            // Mint the app password while 2FA is still off — createApiKey needs a live session.
            const signIn = await auth.api.signInEmail({
                returnHeaders: true,
                body: { email, password: primaryPassword },
            });
            const sessionToken =
                (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';
            const created = await auth.api.createApiKey({
                body: { name: 'twofa-app-password' },
                headers: { cookie: `better-auth.session_token=${sessionToken}` },
            });
            appPassword = created!.key!;

            const row = await getUserByEmail(email);
            userId = row!.id;

            // Flip the real column true — reproduces the exact production end-state the gate keys on.
            await getAuthDrizzleDb().update(user).set({ twoFactorEnabled: true }).where(eq(user.id, userId));
        });

        test('rejects the primary password for a 2FA-enabled user (no bypass)', async () => {
            await expect(verifyProtocolAuth(email, primaryPassword)).rejects.toThrow();
        });

        test('still accepts an app password for a 2FA-enabled user', async () => {
            const u = await verifyProtocolAuth(email, appPassword);
            expect(u.id).toBe(userId);
        });
    });

    // -- Brute-force throttling: count failures, clear on success --

    describe('brute-force throttling', () => {
        test('throttles repeated failures for one email with 429', async () => {
            const email = 'bruteforce-target@test.eigen.is';
            // Ten failed attempts are allowed; the eleventh is refused before any credential work.
            for (let i = 0; i < 10; i++) {
                await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Unauthorized');
            }
            await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Too many failed');
        });

        test('a successful auth clears the failure counter', async () => {
            const email = ctx.alice.user.email;
            // Nine failures — one short of the per-email threshold.
            for (let i = 0; i < 9; i++) {
                await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Unauthorized');
            }
            // A correct primary password gets through and clears the counter. Without the clear,
            // the second wrong attempt below would be the eleventh failure → 429 instead of 401.
            await verifyProtocolAuth(email, 'testpassword123');
            await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Unauthorized');
            await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Unauthorized');
        });

        test('a successful auth does NOT clear the per-IP failure counter', async () => {
            // 49 failures from one IP, each a distinct email so none hits the per-email cap — the
            // brute-force signal lands entirely on the IP bucket (cap 50).
            const ip = '203.0.113.7';
            for (let i = 0; i < 49; i++) {
                await expect(verifyProtocolAuth(`spray-${i}@test.eigen.is`, 'wrongpassword', ip)).rejects.toThrow(
                    'Unauthorized',
                );
            }
            // A valid login from the same IP clears only the EMAIL bucket. If it also cleared the IP
            // bucket, a credentialed attacker could reset the per-IP guard between spray rounds.
            await verifyProtocolAuth(ctx.alice.user.email, 'testpassword123', ip);
            // The 50th failure tips the IP bucket to the cap...
            await expect(verifyProtocolAuth('spray-50@test.eigen.is', 'wrongpassword', ip)).rejects.toThrow(
                'Unauthorized',
            );
            // ...so the next attempt from that IP is refused before any credential work, fresh email or not.
            await expect(verifyProtocolAuth('spray-51@test.eigen.is', 'wrongpassword', ip)).rejects.toThrow(
                'Too many failed',
            );
        });

        // The SASL path (postfix → dovecot → eigen-checkpassword → /internal/auth/verify) forwards
        // dovecot's `IP`, so a botnet spraying one submission port lands on the per-IP bucket.
        test('the internal verify endpoint threads its ip into the per-IP bucket', async () => {
            const attackerIp = '198.51.100.10';
            const verify = (email: string, password: string, ip?: string) =>
                app.handle(
                    new Request('http://localhost/internal/auth/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password, ...(ip ? { ip } : {}) }),
                    }),
                );

            // 50 failures from one IP, each a distinct email so none hits the per-email cap.
            for (let i = 0; i < 50; i++) {
                const res = await verify(`sasl-spray-${i}@test.eigen.is`, 'wrongpassword', attackerIp);
                expect(res.status).toBe(401);
            }
            // The IP bucket is at its cap: the next attempt from that IP is refused before any
            // credential work, fresh email or not.
            const throttled = await verify('sasl-spray-50@test.eigen.is', 'wrongpassword', attackerIp);
            expect(throttled.status).toBe(429);

            // A different client IP is unaffected — the lockout is keyed on the flooding source.
            const other = await verify(ctx.alice.user.email, 'testpassword123', '198.51.100.11');
            expect(other.status).toBe(200);
        });

        test('a valid app password is accepted even when the email failure bucket is saturated', async () => {
            const email = ctx.alice.user.email;
            const created = await auth.api.createApiKey({
                body: { name: 'saturation-app-password' },
                headers: { cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}` },
            });
            const appPassword = created!.key!;

            // Saturate the email bucket: the primary-password path is now refused with 429.
            for (let i = 0; i < 10; i++) {
                await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Unauthorized');
            }
            await expect(verifyProtocolAuth(email, 'wrongpassword')).rejects.toThrow('Too many failed');

            // The app password is checked before the limiter, so a valid credential still gets through.
            const u = await verifyProtocolAuth(email, appPassword);
            expect(u.id).toBe(ctx.alice.user.id);
        });
    });
});
