import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext, TEST_DATA_DIR} from './setup';
import {existsSync} from 'fs';
import {join} from 'path';

describe('Delete user', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let deleteTarget: { id: string; email: string; sessionToken: string };

    beforeAll(async () => {
        ctx = await getTestContext();

        // Create a dedicated user for deletion tests
        const {auth} = await import('../lib/auth/auth');
        const signUp = await auth.api.signUpEmail({
            body: {email: 'deleteme@test.eigen.is', password: 'testpassword123', name: 'Delete Me'},
        });
        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: {email: 'deleteme@test.eigen.is', password: 'testpassword123'},
        });
        const setCookie = signIn.headers.get('set-cookie') || '';
        const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
        deleteTarget = {
            id: signUp.user.id,
            email: 'deleteme@test.eigen.is',
            sessionToken: match![1],
        };

        // Initialize the user's home so data exists on disk
        const sizeRes = await authedRequest(deleteTarget.sessionToken,
            `/home/${deleteTarget.id}/size`);
        expect(sizeRes.status).toBe(200);
    });

    test('admin can read settings before deletion', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        expect(res.status).toBe(200);
    });

    test('non-admin cannot delete a user', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/settings/user/${deleteTarget.id}`,
            {method: 'DELETE'},
        );
        expect(res.status).toBe(403);
    });

    test('admin cannot delete themselves', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/settings/user/${ctx.alice.user.id}`,
            {method: 'DELETE'},
        );
        expect(res.status).toBe(400);
    });

    test('admin cannot delete non-existent user', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            '/settings/user/00000000000000000000000000000000',
            {method: 'DELETE'},
        );
        expect(res.status).toBe(404);
    });

    test('admin can fully delete a user', async () => {
        const homePath = join(TEST_DATA_DIR, 'home', deleteTarget.id);
        expect(existsSync(homePath)).toBe(true);

        const deleteRes = await authedRequest(ctx.alice.user.sessionToken,
            `/settings/user/${deleteTarget.id}`,
            {method: 'DELETE'},
        );
        expect(deleteRes.status).toBe(200);

        // Home directory is gone
        expect(existsSync(homePath)).toBe(false);

        // Deleted user can no longer authenticate
        const authRes = await authedRequest(deleteTarget.sessionToken,
            `/home/${deleteTarget.id}/size`);
        expect(authRes.status).toBe(401);
    });

    test('admin retains admin rights after deleting a user', async () => {
        // Admin can still read settings (requireAdmin check)
        const settingsRes = await authedRequest(ctx.alice.user.sessionToken, '/settings/server');
        expect(settingsRes.status).toBe(200);
    });

    test('admin org membership is intact after deletion', async () => {
        const {getOrgRole, getMemberships} = await import('../lib/user/user');
        const role = await getOrgRole(ctx.alice.user.id);
        expect(role).toBe('owner');

        const memberships = await getMemberships(ctx.alice.user.id);
        expect(memberships.orgIds.length).toBeGreaterThan(0);
    });

    test('active organization survives user deletion', async () => {
        const {getPublicConfig} = await import('../lib/config/server-config');
        const pubConfig = await getPublicConfig();
        const orgId = pubConfig.orgId;
        expect(orgId).toBeTruthy();
        const aliceHeaders = new Headers({cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}`});

        // Set active org on admin session (like the frontend does)
        const setActiveRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });
        expect(setActiveRes.status).toBe(200);

        // Verify it's set
        const {auth} = await import('../lib/auth/auth');
        const sessionBefore = await auth.api.getSession({headers: aliceHeaders});
        expect(sessionBefore!.session.activeOrganizationId).toBe(orgId);

        // Create and delete another user
        const signUp2 = await auth.api.signUpEmail({
            body: {email: 'deleteme2@test.eigen.is', password: 'testpassword123', name: 'Delete Me 2'},
        });
        const signIn2 = await auth.api.signInEmail({
            returnHeaders: true,
            body: {email: 'deleteme2@test.eigen.is', password: 'testpassword123'},
        });
        const setCookie2 = signIn2.headers.get('set-cookie') || '';
        const match2 = setCookie2.match(/better-auth\.session_token=([^;]+)/);

        // Initialize home
        await authedRequest(match2![1], `/home/${signUp2.user.id}/size`);

        // Delete the user
        const delRes = await authedRequest(ctx.alice.user.sessionToken,
            `/settings/user/${signUp2.user.id}`,
            {method: 'DELETE'});
        expect(delRes.status).toBe(200);

        // Check: does admin still have activeOrganizationId?
        const sessionAfter = await auth.api.getSession({headers: aliceHeaders});
        expect(sessionAfter!.session.activeOrganizationId).toBe(orgId);

        // Check: can admin still list members?
        const listRes = await authedRequest(ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}`);
        expect(listRes.status).toBe(200);
        const data = await listRes.json() as any;
        expect(data.members.find((m: any) => m.userId === ctx.alice.user.id)).toBeDefined();
    });

    test('other users retain their membership after deletion', async () => {
        // Bob can still authenticate and access his own data
        const bobRes = await authedRequest(ctx.bob.user.sessionToken,
            `/home/${ctx.bob.user.id}/size`);
        expect(bobRes.status).toBe(200);

        const {getOrgRole} = await import('../lib/user/user');
        const bobRole = await getOrgRole(ctx.bob.user.id);
        expect(bobRole).toBe('member');
    });

    test('deleting same user again returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/settings/user/${deleteTarget.id}`,
            {method: 'DELETE'},
        );
        expect(res.status).toBe(404);
    });
});
