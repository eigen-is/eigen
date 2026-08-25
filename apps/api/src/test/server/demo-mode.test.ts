import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { account as accountSchema, member as memberSchema, user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getDemoPersonaPool } from '../../lib/auth/demo-persona-pool';
import { signInWithScopedPassword } from '../../lib/auth/guest-auth';
import { getServerConfig } from '../../lib/config/server-config';
import { sendMail } from '../../lib/core/mailer';
import { authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function extractSessionToken(headers: Headers): string {
    const setCookie = headers.get('set-cookie') || '';
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`Session token not found in set-cookie header: ${setCookie}`);
    return match[1]!;
}

async function resolveUserId(res: Response): Promise<string> {
    const token = extractSessionToken(res.headers);
    const session = await auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
    });
    if (!session) throw new Error('demo session did not resolve');
    return session.user.id;
}

describe('Demo mode', () => {
    let ctx: TestCtx;
    let orgId: string;
    let originalPasswords: { id: string; password: string | null }[];

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        if (!config) throw new Error('server config not set');
        orgId = config.orgId;
        originalPasswords = getAuthDrizzleDb()
            .select({ id: accountSchema.id, password: accountSchema.password })
            .from(accountSchema)
            .where(eq(accountSchema.providerId, 'credential'))
            .all();
    });

    // Entry sign-ins overwrite the picked persona's password with the demo-derived HMAC; restore the
    // originals so later suite files (WebDAV Basic auth) can still sign in with the seeded passwords.
    afterAll(() => {
        const db = getAuthDrizzleDb();
        for (const row of originalPasswords) {
            db.update(accountSchema).set({ password: row.password }).where(eq(accountSchema.id, row.id)).run();
        }
    });

    // Restore the toggle after every test — a leaked EIGEN_DEMO would 403 api-key creation and
    // skip sendMail across the rest of the shared suite.
    afterEach(() => {
        delete process.env['EIGEN_DEMO'];
    });

    // Optional X-Real-IP so loop tests spread across distinct IPs and never trip the per-IP
    // entry limiter (10/min); the burst test reuses one dedicated IP to prove the cap.
    function enter(ip?: string): Promise<Response> {
        return ctx.app.handle(
            new Request('http://localhost/p/demo/enter', ip ? { headers: { 'x-real-ip': ip } } : undefined),
        );
    }

    describe('demo OFF (default)', () => {
        test('GET /p/demo/enter is 404 and /p/config reports demoMode:false', async () => {
            const enterRes = await enter();
            expect(enterRes.status).toBe(404);

            const configRes = await ctx.app.handle(new Request('http://localhost/p/config'));
            const config = (await configRes.json()) as { demoMode: boolean };
            expect(config.demoMode).toBe(false);
        });

        test('the auth guard is inert: a member can create an api key', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, '/auth/api-key/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'demo-off-key' }),
            });
            expect(res.status).toBe(200);
        });
    });

    describe('demo ON', () => {
        test('/p/config reports demoMode:true', async () => {
            process.env['EIGEN_DEMO'] = '1';
            const configRes = await ctx.app.handle(new Request('http://localhost/p/config'));
            const config = (await configRes.json()) as { demoMode: boolean };
            expect(config.demoMode).toBe(true);
        });

        test('GET /p/demo/enter signs in a random org member (never the owner)', async () => {
            process.env['EIGEN_DEMO'] = '1';
            const res = await enter();
            expect(res.status).toBe(302);
            expect(res.headers.get('location')).toBe('/space');
            expect(res.headers.get('set-cookie') || '').toContain('better-auth.session_token');

            // The pool is org members only (bob/charlie in isolation); the owner (alice) is excluded
            // by the role='member' filter.
            const resolvedId = await resolveUserId(res);
            expect(resolvedId).not.toBe(ctx.alice.user.id);
            const memberRow = getAuthDrizzleDb()
                .select({ role: memberSchema.role })
                .from(memberSchema)
                .where(and(eq(memberSchema.userId, resolvedId), eq(memberSchema.organizationId, orgId)))
                .get();
            expect(memberRow?.role).toBe('member');
        });

        test('re-entry overwrites a tampered persona password (self-healing)', async () => {
            process.env['EIGEN_DEMO'] = '1';
            const db = getAuthDrizzleDb();

            // Corrupt bob's credential so a plain sign-in with his derived password would fail.
            db.update(accountSchema)
                .set({ password: 'tampered-not-a-valid-hash' })
                .where(eq(accountSchema.userId, ctx.bob.user.id))
                .run();

            // The entry route re-derives and overwrites the persona password before signing in, so a
            // visitor's tamper can't lock the next visitor out. Prove it against bob through the exact
            // mechanism the route uses — the shared-DB suite can hold many members, so the route's
            // random pick can't be forced onto bob without poisoning the pool.
            const healed = await signInWithScopedPassword('demo', ctx.bob.user.id, ctx.bob.user.email);
            expect(await resolveUserId(healed)).toBe(ctx.bob.user.id);
            const bobAccount = db
                .select({ password: accountSchema.password })
                .from(accountSchema)
                .where(eq(accountSchema.userId, ctx.bob.user.id))
                .get();
            expect(bobAccount?.password).not.toBe('tampered-not-a-valid-hash');

            // The owner is never a candidate: the role='member' filter keeps alice out of the pool
            // the route draws from — deterministically, not by luck across random draws.
            const pool = getDemoPersonaPool(orgId);
            expect(pool.some((p) => p.id === ctx.alice.user.id)).toBe(false);
        });

        test('rate-limits the public entry route per IP', async () => {
            process.env['EIGEN_DEMO'] = '1';
            const ip = '203.0.113.7'; // dedicated fake IP so no other test can trip this bucket

            // The 10/min per-IP cap allows a short burst, then 429s further hits from the same IP.
            for (let i = 0; i < 10; i++) {
                expect((await enter(ip)).status).toBe(302);
            }
            const limited = await enter(ip);
            expect(limited.status).toBe(429);
        }, 20000);

        test('a 2FA-enabled member is excluded from the pool', () => {
            const db = getAuthDrizzleDb();

            // charlie starts as a plain member, so he must be a candidate up front — otherwise the
            // exclusion below would pass vacuously.
            expect(getDemoPersonaPool(orgId).some((p) => p.id === ctx.charlie.user.id)).toBe(true);

            // A 2FA member would divert signInEmail into the 2FA flow (no session cookie), so the
            // pool query the route draws from must drop them the instant 2FA is enabled.
            db.update(userSchema).set({ twoFactorEnabled: true }).where(eq(userSchema.id, ctx.charlie.user.id)).run();
            try {
                expect(getDemoPersonaPool(orgId).some((p) => p.id === ctx.charlie.user.id)).toBe(false);
            } finally {
                db.update(userSchema)
                    .set({ twoFactorEnabled: false })
                    .where(eq(userSchema.id, ctx.charlie.user.id))
                    .run();
            }

            // Restored: charlie is a candidate again, proving the 2FA flag was the only thing excluding him.
            expect(getDemoPersonaPool(orgId).some((p) => p.id === ctx.charlie.user.id)).toBe(true);
        });

        test('the auth guard blocks the abuse denylist but not other auth routes', async () => {
            process.env['EIGEN_DEMO'] = '1';
            const token = ctx.bob.user.sessionToken;

            const apiKey = await authedRequest(token, '/auth/api-key/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'demo-on-key' }),
            });
            expect(apiKey.status).toBe(403);

            const twoFactor = await authedRequest(token, '/auth/two-factor/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: 'testpassword123' }),
            });
            expect(twoFactor.status).toBe(403);

            const revoke = await authedRequest(token, '/auth/revoke-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(revoke.status).toBe(403);

            const revokeOthers = await authedRequest(token, '/auth/revoke-other-sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(revokeOthers.status).toBe(403);

            // A non-denylisted auth route still works — the guard must not over-block.
            const session = await authedRequest(token, '/auth/get-session');
            expect(session.status).toBe(200);
        });
    });

    test('sendMail skips delivery in demo mode even in production', async () => {
        const prevProduction = process.env['PRODUCTION'];
        const prevSmtp = process.env['SMTP_HOST'];
        process.env['PRODUCTION'] = '1';
        process.env['EIGEN_DEMO'] = '1';
        delete process.env['SMTP_HOST'];
        try {
            const ok = await sendMail({
                to: [{ name: 'Demo', address: 'demo@test.eigen.is' }],
                subject: 'demo skip',
                text: 'should be skipped',
            });
            expect(ok).toBe(true);
        } finally {
            if (prevProduction === undefined) delete process.env['PRODUCTION'];
            else process.env['PRODUCTION'] = prevProduction;
            if (prevSmtp === undefined) delete process.env['SMTP_HOST'];
            else process.env['SMTP_HOST'] = prevSmtp;
            delete process.env['EIGEN_DEMO'];
        }
    });
});
