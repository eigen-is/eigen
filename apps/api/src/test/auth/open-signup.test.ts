import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getTestContext } from '../setup';

describe('Public sign-up', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('POST /auth/sign-up/email is blocked', async () => {
        const res = await ctx.app.handle(
            new Request('http://localhost/auth/sign-up/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: `probe-${randomUUID()}@test.eigen.is`,
                    password: 'testpassword123',
                    name: 'Probe',
                }),
            }),
        );
        expect(res.status).toBe(403);
    });
});
