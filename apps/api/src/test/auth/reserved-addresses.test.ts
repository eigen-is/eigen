import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { auth } from '../../lib/auth/auth';
import { authedRequest, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
let ctx: TestCtx;

beforeAll(async () => {
    ctx = await getTestContext();
});

describe('Reserved mail addresses', () => {
    test('auth.api.createUser rejects a reserved local part on the mail domain', async () => {
        await expect(
            auth.api.createUser({
                body: {
                    email: 'postmaster@test.eigen.is',
                    password: 'testpassword123',
                    name: 'Fake Postmaster',
                    role: 'user',
                },
            }),
        ).rejects.toThrow(/reserved/i);
    });

    test('POST /auth/admin/create-user returns 4xx for a reserved address', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'abuse@test.eigen.is',
                password: 'testpassword123',
                name: 'Fake Abuse',
                role: 'user',
            }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(await res.text()).toMatch(/reserved/i);
    });

    test('a non-role internal address (admin@) is not refused by this rule', async () => {
        // The auth DB is shared across files, so admin@ may already exist — that's still not a "reserved" refusal.
        try {
            const created = await auth.api.createUser({
                body: {
                    email: 'admin@test.eigen.is',
                    password: 'testpassword123',
                    name: 'Real Admin',
                    role: 'user',
                },
            });
            expect(created.user.email).toBe('admin@test.eigen.is');
        } catch (error) {
            expect(error instanceof Error ? error.message : String(error)).not.toMatch(/reserved/i);
        }
    });

    test('POST /guest-auth/request-otp refuses an address on the mail domain', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/guest-auth/request-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'postmaster@test.eigen.is' }),
        });
        expect(res.status).toBe(400);
    });

    test('an external reserved address is not blocked by this rule', async () => {
        const email = `postmaster+${randomUUID()}@example.com`;
        const created = await auth.api.signUpEmail({
            body: { email, password: 'testpassword123', name: 'External Postmaster' },
        });
        expect(created.user.email).toBe(email);
    });

    test('admin update to a reserved address on the mail domain is rejected', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/update-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: ctx.bob.user.id,
                data: { email: 'postmaster@test.eigen.is' },
            }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(await res.text()).toMatch(/reserved/i);
    });
});
