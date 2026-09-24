import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema, user as userSchema } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { getUserById } from '../../lib/user';
import { authedRequest, createTestUser, getTestContext, hasSession, type TestUser } from '../setup';

// Every org admin holds better-auth's user.role 'admin', so the admin plugin's own routes must not reach the owner.
describe("better-auth's admin routes against the owner", () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let admin: TestUser;

    function membership(userId: string) {
        return and(eq(memberSchema.userId, userId), eq(memberSchema.organizationId, getServerConfig()?.orgId ?? ''));
    }

    function adminCall(sessionToken: string, path: string, body: object): Promise<Response> {
        return authedRequest(sessionToken, `/auth/admin/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        admin = await createTestUser('ada-admin-plugin@test.eigen.is', 'testpassword123', 'Ada Plugin');
        const db = getAuthDrizzleDb();
        await db.update(memberSchema).set({ role: 'admin' }).where(membership(admin.id));
        await db.update(userSchema).set({ role: 'admin' }).where(eq(userSchema.id, admin.id));
    });

    // The auth database is the whole suite's.
    afterAll(async () => {
        const db = getAuthDrizzleDb();
        await db.update(memberSchema).set({ role: 'member' }).where(membership(admin.id));
        await db.update(userSchema).set({ role: 'user' }).where(eq(userSchema.id, admin.id));
        await db.update(userSchema).set({ role: 'admin' }).where(eq(userSchema.id, ctx.alice.user.id));
    });

    test("an admin cannot change the owner's role", async () => {
        const res = await adminCall(admin.sessionToken, 'set-role', { userId: ctx.alice.user.id, role: 'user' });
        expect(res.status).toBe(403);
        expect((await getUserById(ctx.alice.user.id))?.role).toBe('admin');
    });

    test('an admin cannot remove the owner', async () => {
        const res = await adminCall(admin.sessionToken, 'remove-user', { userId: ctx.alice.user.id });
        expect(res.status).toBe(403);
        expect(await getUserById(ctx.alice.user.id)).not.toBeNull();
    });

    test("an admin cannot change the owner's address", async () => {
        const res = await adminCall(admin.sessionToken, 'update-user', {
            userId: ctx.alice.user.id,
            data: { email: 'alice@elsewhere.example' },
        });
        expect(res.status).toBe(403);
        expect((await getUserById(ctx.alice.user.id))?.email).toBe(ctx.alice.user.email);
    });

    test("an admin cannot sign the owner's sessions out", async () => {
        const res = await adminCall(admin.sessionToken, 'revoke-user-sessions', { userId: ctx.alice.user.id });
        expect(res.status).toBe(403);
        expect(await hasSession(ctx.alice.user.sessionToken)).toBe(true);
    });

    test("an anonymous call cannot tell the owner's id from another's", async () => {
        const onOwner = await adminCall('', 'set-role', { userId: ctx.alice.user.id, role: 'user' });
        const onAdmin = await adminCall('', 'set-role', { userId: admin.id, role: 'user' });
        expect(onOwner.status).toBe(401);
        expect(onAdmin.status).toBe(401);
    });

    test('an admin still acts on a member', async () => {
        const member = await createTestUser('max-admin-plugin@test.eigen.is', 'testpassword123', 'Max Plugin');
        const res = await adminCall(admin.sessionToken, 'update-user', { userId: member.id, data: { name: 'Max' } });
        expect(res.status).toBe(200);
        expect((await getUserById(member.id))?.name).toBe('Max');
    });

    test('the owner still acts on herself', async () => {
        const res = await adminCall(ctx.alice.user.sessionToken, 'update-user', {
            userId: ctx.alice.user.id,
            data: { name: 'Alice Renamed' },
        });
        expect(res.status).toBe(200);
        expect((await getUserById(ctx.alice.user.id))?.name).toBe('Alice Renamed');
        await adminCall(ctx.alice.user.sessionToken, 'update-user', {
            userId: ctx.alice.user.id,
            data: { name: ctx.alice.user.name },
        });
    });

    test('impersonation is closed, even for the owner', async () => {
        const res = await adminCall(ctx.alice.user.sessionToken, 'impersonate-user', { userId: admin.id });
        expect(res.status).toBe(404);
    });
});
