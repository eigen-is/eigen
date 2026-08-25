import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgMember } from '@workspace/lib/types/admin';
import { eq } from 'drizzle-orm';
import { addMember, assertJson, authedRequest, createTeam, findOrFail, getTestContext, TEST_DATA_DIR } from '../setup';

describe('Delete user', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let deleteTarget: { id: string; email: string; sessionToken: string };

    beforeAll(async () => {
        ctx = await getTestContext();

        // Create a dedicated user for deletion tests
        const { auth } = await import('../../lib/auth/auth');
        const signUp = await auth.api.signUpEmail({
            body: { email: 'deleteme@test.eigen.is', password: 'testpassword123', name: 'Delete Me' },
        });
        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email: 'deleteme@test.eigen.is', password: 'testpassword123' },
        });
        const setCookie = signIn.headers.get('set-cookie') || '';
        const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
        deleteTarget = {
            id: signUp.user.id,
            email: 'deleteme@test.eigen.is',
            sessionToken: match![1],
        };

        // Initialize the user's home so data exists on disk
        const sizeRes = await authedRequest(deleteTarget.sessionToken, `/home/${deleteTarget.id}/size`);
        expect(sizeRes.status).toBe(200);
    });

    test('admin can read settings before deletion', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        expect(res.status).toBe(200);
    });

    test('non-admin cannot delete a user', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/settings/user/${deleteTarget.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(403);
    });

    test('admin cannot delete themselves', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${ctx.alice.user.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(400);
    });

    test('admin cannot delete non-existent user', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            '/settings/user/00000000000000000000000000000000',
            { method: 'DELETE' },
        );
        expect(res.status).toBe(404);
    });

    test('admin can fully delete a user', async () => {
        const homePath = join(TEST_DATA_DIR, 'home', deleteTarget.id);
        expect(existsSync(homePath)).toBe(true);

        const deleteRes = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${deleteTarget.id}`, {
            method: 'DELETE',
        });
        expect(deleteRes.status).toBe(200);

        // Home directory is gone
        expect(existsSync(homePath)).toBe(false);

        // Deleted user can no longer authenticate
        const authRes = await authedRequest(deleteTarget.sessionToken, `/home/${deleteTarget.id}/size`);
        expect(authRes.status).toBe(401);
    });

    test('admin retains admin rights after deleting a user', async () => {
        // Admin can still read settings (requireAdmin check)
        const settingsRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        expect(settingsRes.status).toBe(200);
    });

    test('admin org membership is intact after deletion', async () => {
        const { getOrgRole, getMemberships } = await import('../../lib/user/user');
        const role = await getOrgRole(ctx.alice.user.id);
        expect(role).toBe('owner');

        const memberships = await getMemberships(ctx.alice.user.id);
        expect(memberships.orgIds.length).toBeGreaterThan(0);
    });

    test('active organization survives user deletion', async () => {
        const { getPublicConfig } = await import('../../lib/config/server-config');
        const pubConfig = await getPublicConfig();
        const orgId = pubConfig.orgId;
        expect(orgId).toBeTruthy();
        const aliceHeaders = new Headers({ cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}` });

        // Set active org on admin session (like the frontend does)
        const setActiveRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        expect(setActiveRes.status).toBe(200);

        // Verify it's set
        const { auth } = await import('../../lib/auth/auth');
        const sessionBefore = await auth.api.getSession({ headers: aliceHeaders });
        expect(sessionBefore!.session.activeOrganizationId).toBe(orgId);

        // Create and delete another user
        const signUp2 = await auth.api.signUpEmail({
            body: { email: 'deleteme2@test.eigen.is', password: 'testpassword123', name: 'Delete Me 2' },
        });
        const signIn2 = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email: 'deleteme2@test.eigen.is', password: 'testpassword123' },
        });
        const setCookie2 = signIn2.headers.get('set-cookie') || '';
        const match2 = setCookie2.match(/better-auth\.session_token=([^;]+)/);

        // Initialize home
        await authedRequest(match2![1], `/home/${signUp2.user.id}/size`);

        // Delete the user
        const delRes = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${signUp2.user.id}`, {
            method: 'DELETE',
        });
        expect(delRes.status).toBe(200);

        // Check: does admin still have activeOrganizationId?
        const sessionAfter = await auth.api.getSession({ headers: aliceHeaders });
        expect(sessionAfter!.session.activeOrganizationId).toBe(orgId);

        // Check: can admin still list members?
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(listRes.status).toBe(200);
        const data = await assertJson<{ members: OrgMember[] }>(listRes);
        findOrFail(data.members, (m) => m.userId === ctx.alice.user.id);
    });

    test('other users retain their membership after deletion', async () => {
        // Bob can still authenticate and access his own data
        const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/home/${ctx.bob.user.id}/size`);
        expect(bobRes.status).toBe(200);

        const { getOrgRole } = await import('../../lib/user/user');
        const bobRole = await getOrgRole(ctx.bob.user.id);
        expect(bobRole).toBe('member');
    });

    test('deleting same user again returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${deleteTarget.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(404);
    });

    test('deleting a user removes org and team membership rows', async () => {
        const { auth, getAuthDrizzleDb } = await import('../../lib/auth/auth');
        const { member, teamMember } = await import('../../../auth-schema');
        const { getServerConfig } = await import('../../lib/config/server-config');
        const orgId = getServerConfig()!.orgId;
        const db = getAuthDrizzleDb();

        const signUp = await auth.api.signUpEmail({
            body: { email: 'member-rows@test.eigen.is', password: 'testpassword123', name: 'Member Rows' },
        });
        const userId = signUp.user.id;
        const teamId = await createTeam(ctx, orgId, 'Delete User Team');
        await addMember(ctx, teamId, userId);

        // The user-create hook auto-added the user to the default org
        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(1);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(1);

        const delRes = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${userId}`, {
            method: 'DELETE',
        });
        expect(delRes.status).toBe(200);

        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(0);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(0);

        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(listRes.status).toBe(200);
    });

    test("better-auth's raw admin remove-user leaves no orphaned membership rows", async () => {
        const { auth, getAuthDrizzleDb } = await import('../../lib/auth/auth');
        const { member, teamMember } = await import('../../../auth-schema');
        const { getServerConfig } = await import('../../lib/config/server-config');
        const orgId = getServerConfig()!.orgId;
        const db = getAuthDrizzleDb();

        const signUp = await auth.api.signUpEmail({
            body: { email: 'raw-remove@test.eigen.is', password: 'testpassword123', name: 'Raw Remove' },
        });
        const userId = signUp.user.id;
        const teamId = await createTeam(ctx, orgId, 'Raw Remove Team');
        await addMember(ctx, teamId, userId);

        // Deletion path that bypasses deleteUserCompletely — better-auth removes only
        // session/account/user rows itself, and the auth DB's FK cascades are inert
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/remove-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        expect(res.status).toBe(200);

        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(0);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(0);

        // The regression that locked the admin UI: one orphaned member row 500s
        // listMembers for the whole org
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(listRes.status).toBe(200);
    });

    test("better-auth's raw admin remove-user runs the complete Eigen teardown", async () => {
        const { auth, getAuthDrizzleDb } = await import('../../lib/auth/auth');
        const { member, teamMember } = await import('../../../auth-schema');
        const { addRegistryEntry, getEntriesForTarget } = await import('../../lib/share/registry');
        const { getEigenDb } = await import('../../lib/share/db');
        const { shareRegistry } = await import('../../lib/share/schema');
        const { getServerConfig } = await import('../../lib/config/server-config');
        const orgId = getServerConfig()!.orgId;
        const db = getAuthDrizzleDb();

        const email = 'raw-teardown@test.eigen.is';
        const signUp = await auth.api.signUpEmail({
            body: { email, password: 'testpassword123', name: 'Raw Teardown' },
        });
        const userId = signUp.user.id;
        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email, password: 'testpassword123' },
        });
        const token = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)![1];

        // Materialize the home directory on disk
        await authedRequest(token, `/home/${userId}/size`);
        const homePath = join(TEST_DATA_DIR, 'home', userId);
        expect(existsSync(homePath)).toBe(true);

        // Team membership + share-registry entries in both directions
        const teamId = await createTeam(ctx, orgId, 'Raw Teardown Team');
        await addMember(ctx, teamId, userId);
        await addRegistryEntry(ctx.alice.user.id, email);
        await addRegistryEntry(userId, 'external-target@example.com');

        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/remove-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        expect(res.status).toBe(200);

        // Complete teardown, same as deleteUserCompletely: home directory gone,
        // share registry cleaned in both directions, auth reference rows gone
        expect(existsSync(homePath)).toBe(false);
        expect(await getEntriesForTarget(email)).toHaveLength(0);
        const eigenDb = await getEigenDb();
        expect(eigenDb.select().from(shareRegistry).where(eq(shareRegistry.fromUserId, userId)).all()).toHaveLength(0);
        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(0);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(0);

        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(listRes.status).toBe(200);
    });

    test("better-auth's raw admin remove-user rejects self-removal without tearing data down", async () => {
        // Materialize Alice's home so a destructive teardown would be observable
        await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        const homePath = join(TEST_DATA_DIR, 'home', ctx.alice.user.id);
        expect(existsSync(homePath)).toBe(true);

        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/remove-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: ctx.alice.user.id }),
        });
        expect(res.status).toBe(400);
        expect(existsSync(homePath)).toBe(true);
    });

    test("better-auth's raw admin remove-user rejects non-admin callers", async () => {
        await authedRequest(ctx.charlie.user.sessionToken, `/home/${ctx.charlie.user.id}/size`);
        const homePath = join(TEST_DATA_DIR, 'home', ctx.charlie.user.id);
        expect(existsSync(homePath)).toBe(true);

        const res = await authedRequest(ctx.bob.user.sessionToken, '/auth/admin/remove-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: ctx.charlie.user.id }),
        });
        expect(res.status).toBe(403);
        expect(existsSync(homePath)).toBe(true);
    });

    test('user deletion sweeps membership rows orphaned by past deletions', async () => {
        const { auth, getAuthDrizzleDb } = await import('../../lib/auth/auth');
        const { member } = await import('../../../auth-schema');
        const { getServerConfig } = await import('../../lib/config/server-config');
        const orgId = getServerConfig()!.orgId;
        const db = getAuthDrizzleDb();

        // Forge the orphan class found in the wild: a member row whose user is gone
        db.insert(member)
            .values({
                id: 'orphaned-member-row',
                organizationId: orgId,
                userId: 'ghost-user-id',
                role: 'member',
                createdAt: new Date(),
            })
            .run();
        const brokenRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(brokenRes.status).toBe(500);

        // Deleting any user through the real route heals the org
        const signUp = await auth.api.signUpEmail({
            body: { email: 'sweep-trigger@test.eigen.is', password: 'testpassword123', name: 'Sweep Trigger' },
        });
        const delRes = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${signUp.user.id}`, {
            method: 'DELETE',
        });
        expect(delRes.status).toBe(200);

        expect(db.select().from(member).where(eq(member.userId, 'ghost-user-id')).all()).toHaveLength(0);
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`,
        );
        expect(listRes.status).toBe(200);
    });
});
