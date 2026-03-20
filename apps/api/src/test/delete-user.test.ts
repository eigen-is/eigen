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

    test('deleting same user again returns 404', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/settings/user/${deleteTarget.id}`,
            {method: 'DELETE'},
        );
        expect(res.status).toBe(404);
    });
});
