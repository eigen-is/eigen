import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { updateServerSettings } from '../../lib/config/server-settings';
import { getTestContext } from '../setup';

describe('Open signup gate', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    // Default is closed, but restore explicitly so no earlier flip leaks out of this file.
    afterAll(async () => {
        await updateServerSettings({ onboarding: { openSignup: false } });
    });

    const signUp = (email: string) =>
        ctx.app.handle(
            new Request('http://localhost/auth/sign-up/email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: 'testpassword123', name: 'Signup Test' }),
            }),
        );

    test('rejects HTTP sign-up when openSignup is false (default)', async () => {
        await updateServerSettings({ onboarding: { openSignup: false } });
        const res = await signUp(`closed-${randomUUID()}@test.eigen.is`);
        expect(res.status).toBe(403);
    });

    test('accepts HTTP sign-up when openSignup is true', async () => {
        await updateServerSettings({ onboarding: { openSignup: true } });
        try {
            const res = await signUp(`open-${randomUUID()}@test.eigen.is`);
            expect(res.status).toBe(200);
        } finally {
            await updateServerSettings({ onboarding: { openSignup: false } });
        }
    });
});
