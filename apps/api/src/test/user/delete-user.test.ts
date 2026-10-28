import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgMember } from '@workspace/lib/types/admin';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FAILED_RESTORE_SUFFIX, PRE_RESTORE_SUFFIX } from '@workspace/lib/validation';
import { eq } from 'drizzle-orm';
import { collectHomeObjects, deleteBucketObjects } from '../../lib/backup/safety-copy';
import { updateServerSettings } from '../../lib/config/server-settings';
import { evictHome, getHome } from '../../lib/home/get-home';
import { LocalStorage } from '../../lib/storage/local-storage';
import { deleteUserCompletely } from '../../lib/user/delete-user';
import { FakeS3Server } from '../fake-s3-server';
import type { TestUser } from '../setup';
import {
    addMember,
    assertJson,
    authedRequest,
    createTeam,
    createTestUserOnStorage,
    driveUpload,
    eventually,
    findOrFail,
    getTestContext,
    openMountMetadata,
    TEST_DATA_DIR,
    TEST_PNG_BYTES,
} from '../setup';

// list-members answers a page of 100, and one sequential run of the suite holds more users than that.
const EVERY_MEMBER = 100_000;

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
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
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

    test("a deletion while the user's home slot is held answers 409 and keeps the home and the sign-in", async () => {
        const { auth } = await import('../../lib/auth/auth');
        const { waitForHomeSlot } = await import('../../lib/backup/jobs');
        const credentials = { email: 'busy-home@test.eigen.is', password: 'testpassword123' };
        const signUp = await auth.api.signUpEmail({ body: { ...credentials, name: 'Busy Home' } });
        const userId = signUp.user.id;
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: credentials });
        const token = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/)![1];
        await getHome(userId);
        await evictHome(userId);
        const homePath = join(TEST_DATA_DIR, 'home', userId);
        const preRestore = `${homePath}${PRE_RESTORE_SUFFIX}20200101-000000`;
        cpSync(homePath, preRestore, { recursive: true });

        const release = await waitForHomeSlot(userId, 'restore');
        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${userId}`, {
                method: 'DELETE',
            });
            // better-auth drops sessions and the password before the user row, and nothing rolls them back.
            const expectStillSignedIn = async () => {
                expect((await authedRequest(token, `/home/${userId}/size`)).status).toBe(200);
                expect((await auth.api.signInEmail({ body: credentials })).user.id).toBe(userId);
            };
            expect(res.status).toBe(409);
            await expectStillSignedIn();
            const raw = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/remove-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            expect(raw.status).toBe(409);
            await expectStillSignedIn();
            // A non-admin learns nothing about a running job: the plugin's own refusal.
            const byMember = await authedRequest(ctx.bob.user.sessionToken, '/auth/admin/remove-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            expect(byMember.status).toBe(403);
            await expectStillSignedIn();
            await expect(deleteUserCompletely(userId, null)).rejects.toMatchObject({ status: 409 });
            await expectStillSignedIn();
            expect(existsSync(homePath)).toBe(true);
            expect(existsSync(preRestore)).toBe(true);
        } finally {
            release();
        }

        const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${userId}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(existsSync(homePath)).toBe(false);
        expect(existsSync(preRestore)).toBe(false);
    });

    test('a home slot taken after the pre-check still answers 409 from the delete hook, as a team delete does', async () => {
        const { auth } = await import('../../lib/auth/auth');
        const jobs = await import('../../lib/backup/jobs');
        const signUp = await auth.api.signUpEmail({
            body: { email: 'late-slot@test.eigen.is', password: 'testpassword123', name: 'Late Slot' },
        });
        const userId = signUp.user.id;
        await getHome(userId);
        await evictHome(userId);

        const release = await jobs.waitForHomeSlot(userId, 'restore');
        // The admin pre-check passes once, as if a job took the slot right after it.
        const preCheck = spyOn(jobs, 'requireHomeSlotFree').mockImplementationOnce(() => {});
        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/admin/remove-user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            expect(res.status).toBe(409);
            expect(existsSync(join(TEST_DATA_DIR, 'home', userId))).toBe(true);
        } finally {
            preCheck.mockRestore();
            release();
        }
        await deleteUserCompletely(userId, null);
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

        // The user-create hook auto-added the user to the default org and its default team
        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(1);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(2);

        const delRes = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${userId}`, {
            method: 'DELETE',
        });
        expect(delRes.status).toBe(200);

        expect(db.select().from(member).where(eq(member.userId, userId)).all()).toHaveLength(0);
        expect(db.select().from(teamMember).where(eq(teamMember.userId, userId)).all()).toHaveLength(0);

        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
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
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
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
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
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
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
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
            `/auth/organization/list-members?organizationId=${orgId}&limit=${EVERY_MEMBER}`,
        );
        expect(listRes.status).toBe(200);
    });
});

describe("Delete user: the home's bucket objects", () => {
    const backing = join(TEST_DATA_DIR, 'delete-user-s3-backing');
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let fake: FakeS3Server;
    // Users the tests keep: a later whole-server backup would try their homes on a bucket that is gone.
    const kept: { user: TestUser; keys: string[] }[] = [];

    beforeAll(async () => {
        ctx = await getTestContext();
        fake = new FakeS3Server(new LocalStorage(backing));
        await updateServerSettings({ defaults: { mount: { s3Config: await fake.start() } } });
    });

    afterAll(async () => {
        for (const { user, keys } of kept) {
            await deleteUserCompletely(user.id, null);
            await deleted(keys);
        }
        await updateServerSettings({ defaults: { mount: { s3Config: undefined } } });
        await fake.stop();
        rmSync(backing, { recursive: true, force: true });
    });

    // The bucket deletes a user deletion runs in the background.
    async function deleted(keys: string[]): Promise<void> {
        await eventually(
            async () => {
                for (const key of keys) if (await fake.store.exists(key)) return undefined;
                return true;
            },
            `the bucket deletes of ${keys.join(', ')}`,
        );
    }

    function homeDirOf(userId: string): string {
        return join(TEST_DATA_DIR, 'home', userId);
    }

    function metadataPathOf(folder: string): string {
        return join(folder, 'mounts', 'default', 'metadata.db');
    }

    // A user whose default drive is the server's bucket: its settings.json carries no S3 config of its own.
    async function s3UserWithUploads(name: string, count = 1): Promise<{ user: TestUser; keys: string[] }> {
        const user = await createTestUserOnStorage('s3', name);
        const root = await assertJson<DrivePath>(
            await authedRequest(user.sessionToken, `/drive/${user.id}/default/root`),
        );
        for (let i = 0; i < count; i++) {
            const file = new File([TEST_PNG_BYTES], `photo-${i}.png`, { type: 'image/png' });
            await driveUpload(user.sessionToken, user.id, 'default', root.id, file);
        }
        await evictHome(user.id);
        const settings = JSON.parse(readFileSync(join(homeDirOf(user.id), 'settings.json'), 'utf8'));
        expect(settings.mounts.default.storageType).toBe('s3');
        expect(settings.mounts.default.s3Config).toBeUndefined();
        const keys = fileKeysOf(metadataPathOf(homeDirOf(user.id)));
        expect(keys).toHaveLength(count);
        for (const key of keys) expect(await fake.store.exists(key)).toBe(true);
        return { user, keys };
    }

    function fileKeysOf(metadataPath: string): string[] {
        const db = openMountMetadata(metadataPath);
        try {
            return db
                .query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'")
                .all()
                .map((row) => row.file);
        } finally {
            db.close();
        }
    }

    // A copy of the folder `source` whose file rows all name `key`, an object only this copy points at.
    async function copyNaming(source: string, target: string, metadataPath: string, key: string): Promise<void> {
        cpSync(source, target, { recursive: true });
        const db = openMountMetadata(metadataPath);
        try {
            db.run("UPDATE paths SET file = ? WHERE type = 'file'", [key]);
        } finally {
            db.close();
        }
        await fake.store.write(key, TEST_PNG_BYTES);
    }

    test('deleting a user takes every object its s3 drives and safety copies name, and the copies', async () => {
        const { user: doomed, keys: doomedKeys } = await s3UserWithUploads('Doomed S3');
        const { user: keptUser, keys: keptKeys } = await s3UserWithUploads('Kept S3');
        kept.push({ user: keptUser, keys: keptKeys });
        const homeDir = homeDirOf(doomed.id);

        const preRestore = `${homeDir}${PRE_RESTORE_SUFFIX}20200101-000000`;
        const failedRestore = `${homeDir}${FAILED_RESTORE_SUFFIX}20200102-000000`;
        await copyNaming(homeDir, preRestore, metadataPathOf(preRestore), 'pre-restore-only.png');
        await copyNaming(homeDir, failedRestore, metadataPathOf(failedRestore), 'failed-restore-only.png');

        // A local-key drive's keys are files in its folder: an object of the same name in the bucket is not its.
        const settingsPath = join(homeDir, 'settings.json');
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        settings.mounts.side = { storageType: 'local-key', enabled: true };
        writeFileSync(settingsPath, JSON.stringify(settings));
        const sideDir = join(homeDir, 'mounts', 'side');
        await copyNaming(
            join(homeDir, 'mounts', 'default'),
            sideDir,
            join(sideDir, 'metadata.db'),
            'local-key-only.png',
        );

        // Another home's safety copy, and an object nothing in this server names.
        const keptCopy = `${homeDirOf(keptUser.id)}${PRE_RESTORE_SUFFIX}20200101-000000`;
        await copyNaming(homeDirOf(keptUser.id), keptCopy, metadataPathOf(keptCopy), 'kept-copy-only.png');
        await fake.store.write('stranger.bin', TEST_PNG_BYTES);

        const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${doomed.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);
        expect(existsSync(homeDir)).toBe(false);
        expect(existsSync(preRestore)).toBe(false);
        expect(existsSync(failedRestore)).toBe(false);
        await deleted([...doomedKeys, 'pre-restore-only.png', 'failed-restore-only.png']);

        for (const key of [...keptKeys, 'kept-copy-only.png', 'local-key-only.png', 'stranger.bin']) {
            expect(await fake.store.exists(key)).toBe(true);
        }
        expect(existsSync(keptCopy)).toBe(true);
        rmSync(keptCopy, { recursive: true, force: true });
    });

    test('a bucket that refuses every delete is given up on early, and every object counts as failed', async () => {
        const { user, keys } = await s3UserWithUploads('Dead Bucket S3', 30);
        for (const key of keys) fake.faults.set(key, 'deny');
        try {
            const { buckets } = collectHomeObjects(homeDirOf(user.id));
            expect(buckets.reduce((sum, bucket) => sum + bucket.keys.size, 0)).toBe(30);
            expect((await deleteBucketObjects(buckets)).sort()).toEqual([...keys].sort());
            const attempts = keys.reduce((sum, key) => sum + (fake.deletes.get(key) ?? 0), 0);
            expect(attempts).toBeGreaterThanOrEqual(10);
            expect(attempts).toBeLessThan(20);
        } finally {
            for (const key of keys) fake.faults.delete(key);
            kept.push({ user, keys });
        }
    });

    test('a bucket that refuses a delete does not keep the user, and the log names the key it left', async () => {
        const { user, keys } = await s3UserWithUploads('Refused S3', 2);
        const [refused, deletable] = keys;
        fake.faults.set(refused, 'deny');
        const warn = spyOn(console, 'warn');
        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${user.id}`, {
                method: 'DELETE',
            });
            expect(res.status).toBe(200);
            expect(existsSync(homeDirOf(user.id))).toBe(false);
            await deleted([deletable]);
            const line = await eventually(
                async () => failedObjectsLine(warn.mock.calls, user.id),
                'the failed-objects log',
            );
            expect(line).toContain(refused);
            expect(line).not.toContain(deletable);
            expect(await fake.store.exists(refused)).toBe(true);
            expect(await fake.store.exists(deletable)).toBe(false);
        } finally {
            warn.mockRestore();
            fake.faults.delete(refused);
        }
    });

    test('the log of a refusing bucket names the first 50 keys left and counts the rest', async () => {
        const { user, keys } = await s3UserWithUploads('Refused Many S3', 55);
        for (const key of keys) fake.faults.set(key, 'deny');
        const warn = spyOn(console, 'warn');
        try {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${user.id}`, {
                method: 'DELETE',
            });
            expect(res.status).toBe(200);
            const line = await eventually(
                async () => failedObjectsLine(warn.mock.calls, user.id),
                'the failed-objects log',
            );
            expect(line).toContain('55 bucket objects');
            expect(keys.filter((key) => line.includes(key))).toHaveLength(50);
            expect(line).toContain('5 more');
        } finally {
            warn.mockRestore();
            for (const key of keys) fake.faults.delete(key);
        }
    });

    function failedObjectsLine(calls: unknown[][], userId: string): string | undefined {
        return calls
            .map((args) => String(args[0]))
            .find((message) => message.includes(`of ${userId} could not be deleted`));
    }
});
