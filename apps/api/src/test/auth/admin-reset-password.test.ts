import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { verifyProtocolAuth } from '../../lib/auth/protocol-auth';
import { authedRequest, createTestUser, getTestContext } from '../setup';

const OLD_PASSWORD = 'old-password-1';

async function signsIn(email: string, password: string): Promise<boolean> {
    try {
        await auth.api.signInEmail({ body: { email, password } });
        return true;
    } catch {
        return false;
    }
}

async function hasSession(token: string): Promise<boolean> {
    const session = await auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
    });
    return session !== null;
}

describe('PUT /settings/user/:userId/password', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    function resetAs(sessionToken: string, userId: string, password: string): Promise<Response> {
        return authedRequest(sessionToken, `/settings/user/${userId}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
    }

    test('sets the new password and signs every session and app password out', async () => {
        const dana = await createTestUser('dana-admin-reset@test.eigen.is', OLD_PASSWORD, 'Dana Reset');
        const appPassword = await auth.api.createApiKey({
            body: { name: 'phone' },
            headers: { cookie: `better-auth.session_token=${dana.sessionToken}` },
        });
        expect((await verifyProtocolAuth(dana.email, appPassword.key)).id).toBe(dana.id);

        const res = await resetAs(ctx.alice.user.sessionToken, dana.id, 'new-password-1');
        expect(res.status).toBe(200);

        expect(await hasSession(dana.sessionToken)).toBe(false);
        await expect(verifyProtocolAuth(dana.email, appPassword.key)).rejects.toThrow('Unauthorized');
        expect(await signsIn(dana.email, OLD_PASSWORD)).toBe(false);
        expect(await signsIn(dana.email, 'new-password-1')).toBe(true);
    });

    test('a guest has no password to reset', async () => {
        const guest = await createTestUser('guest-admin-reset@test.eigen.is', OLD_PASSWORD, 'Guest Reset');
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, guest.id)).run();
        const res = await resetAs(ctx.alice.user.sessionToken, guest.id, 'new-password-1');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('guest');
        expect(await hasSession(guest.sessionToken)).toBe(true);
    });

    test("the owner's password is not an admin's to reset", async () => {
        const res = await resetAs(ctx.alice.user.sessionToken, ctx.alice.user.id, 'testpassword123');
        expect(res.status).toBe(403);
        expect(await hasSession(ctx.alice.user.sessionToken)).toBe(true);
    });

    test('an unknown user is a 404', async () => {
        const res = await resetAs(ctx.alice.user.sessionToken, '00000000000000000000000000000000', 'new-password-1');
        expect(res.status).toBe(404);
    });

    test("better-auth's own set-user-password, which revokes nothing, is closed", async () => {
        const fern = await createTestUser('fern-admin-reset@test.eigen.is', OLD_PASSWORD, 'Fern Reset');
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/set-user-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: fern.id, newPassword: 'new-password-1' }),
        });
        expect(res.status).toBe(404);
        expect(await signsIn(fern.email, OLD_PASSWORD)).toBe(true);
    });

    test('a non-admin is refused', async () => {
        const erik = await createTestUser('erik-admin-reset@test.eigen.is', OLD_PASSWORD, 'Erik Reset');
        const res = await resetAs(ctx.bob.user.sessionToken, erik.id, 'new-password-1');
        expect(res.status).toBe(403);
        expect(await signsIn(erik.email, OLD_PASSWORD)).toBe(true);
    });
});
