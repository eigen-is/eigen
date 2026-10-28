import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { member as memberSchema, user as userSchema } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { getUserById } from '../../lib/user';
import type { TestUser } from '../setup';
import { authedRequest, createTestGuest, createTestUser, getTestContext } from '../setup';

// better-auth's admin routes know the roles admin and user only, and leave a guest's account alone.
describe("better-auth's admin routes and roles", () => {
    let admin: TestUser;
    let member: TestUser;
    let guest: TestUser;

    function membership(userId: string) {
        return and(eq(memberSchema.userId, userId), eq(memberSchema.organizationId, getServerConfig()?.orgId ?? ''));
    }

    function adminCall(path: string, body: object): Promise<Response> {
        return authedRequest(admin.sessionToken, `/auth/admin/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    beforeAll(async () => {
        await getTestContext();
        admin = await createTestUser('ada-admin-roles@test.eigen.is', 'testpassword123', 'Ada Roles');
        const db = getAuthDrizzleDb();
        await db.update(memberSchema).set({ role: 'admin' }).where(membership(admin.id));
        await db.update(userSchema).set({ role: 'admin' }).where(eq(userSchema.id, admin.id));
        member = await createTestUser('max-admin-roles@test.eigen.is', 'testpassword123', 'Max Roles');
        guest = await createTestGuest('Gina Roles');
    });

    // The auth database is the whole suite's.
    afterAll(async () => {
        const db = getAuthDrizzleDb();
        await db.update(memberSchema).set({ role: 'member' }).where(membership(admin.id));
        await db.update(userSchema).set({ role: 'user' }).where(eq(userSchema.id, admin.id));
    });

    test('set-role refuses a role other than admin or user', async () => {
        const res = await adminCall('set-role', { userId: member.id, role: 'guest' });
        expect(res.status).toBe(400);
        expect((await getUserById(member.id))?.role).toBe('user');
    });

    test('update-user refuses a role other than admin or user', async () => {
        const res = await adminCall('update-user', { userId: member.id, data: { role: 'guest' } });
        expect(res.status).toBe(400);
        expect((await getUserById(member.id))?.role).toBe('user');
    });

    test('create-user refuses a role other than admin or user', async () => {
        const res = await adminCall('create-user', {
            email: 'gus-admin-roles@test.eigen.is',
            password: 'testpassword123',
            name: 'Gus Roles',
            role: 'guest',
        });
        expect(res.status).toBe(400);
    });

    test('set-role leaves a guest a guest', async () => {
        const res = await adminCall('set-role', { userId: guest.id, role: 'user' });
        expect(res.status).toBe(403);
        expect((await getUserById(guest.id))?.role).toBe('guest');
    });

    test("update-user leaves a guest's account alone", async () => {
        const toUser = await adminCall('update-user', { userId: guest.id, data: { role: 'user' } });
        const rename = await adminCall('update-user', { userId: guest.id, data: { name: 'Renamed' } });
        expect(toUser.status).toBe(403);
        expect(rename.status).toBe(403);
        const row = await getUserById(guest.id);
        expect(row?.role).toBe('guest');
        expect(row?.name).toBe('Gina Roles');
    });

    test('an admin still makes a member an admin and back', async () => {
        expect((await adminCall('set-role', { userId: member.id, role: 'admin' })).status).toBe(200);
        expect((await getUserById(member.id))?.role).toBe('admin');
        expect((await adminCall('set-role', { userId: member.id, role: 'user' })).status).toBe(200);
        expect((await getUserById(member.id))?.role).toBe('user');
    });
});
