import { beforeAll, describe, expect, test } from 'bun:test';
import { type DriveACL, type DrivePath, type MountInfo, type OrgTeam, teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../../lib/config/server-config';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetPermission,
    drivePost,
    drivePut,
    findOrFail,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const BOB_EMAIL = 'bob@test.eigen.is';
const CHARLIE_EMAIL = 'charlie@test.eigen.is';

async function putACL(token: string, ownerId: string, mountId: string, pathId: string, body: Record<string, unknown>) {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/path/${pathId}/acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('Sharing Restricted', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    describe('default behavior (unrestricted)', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Unrestricted Folder' },
            );
            folderId = folder.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
        });

        test('sharingRestricted defaults to false', async () => {
            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.sharingRestricted).toBe(false);
        });

        test('editor can modify ACL when unrestricted', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });
            expect(res.status).toBe(200);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.acl).toContainEqual({ id: CHARLIE_EMAIL, read: true, write: false });
        });

        test('cleanup: remove charlie, restore bob-only ACL', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                remove: [CHARLIE_EMAIL],
            });
        });
    });

    describe('owner restricts sharing', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Restricted Folder' },
            );
            folderId = folder.id;

            // Share with Bob (write) and enable restriction in the same call
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
                sharingRestricted: true,
            });
        });

        test('sharingRestricted is persisted', async () => {
            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.sharingRestricted).toBe(true);
        });

        test('editor is blocked from modifying ACL', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });
            expect(res.status).toBe(403);

            // ACL unchanged
            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            const charlieEntry = path.acl?.find((e: DriveACL) => e.id === CHARLIE_EMAIL);
            expect(charlieEntry).toBeUndefined();
        });

        test('editor is blocked from changing visibility', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                visibility: 'public-read',
            });
            expect(res.status).toBe(403);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.visibility).toBe('private');
        });

        test('editor cannot toggle sharingRestricted flag', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                sharingRestricted: false,
            });
            expect(res.status).toBe(403);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.sharingRestricted).toBe(true);
        });

        test('editor can still edit content (write is not affected)', async () => {
            const subfolder = await drivePost(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderId}`,
                { folderName: 'Bob Can Still Write' },
            );
            expect(subfolder.name).toBe('Bob Can Still Write');
        });

        test('owner can still modify ACL', async () => {
            const res = await putACL(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });
            expect(res.status).toBe(200);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.acl).toContainEqual({ id: CHARLIE_EMAIL, read: true, write: false });
        });

        test('owner can change visibility while restricted', async () => {
            const res = await putACL(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                visibility: 'public-read',
            });
            expect(res.status).toBe(200);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.visibility).toBe('public-read');
        });

        test('owner can unrestrict', async () => {
            const res = await putACL(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                sharingRestricted: false,
            });
            expect(res.status).toBe(200);

            const path = await driveGet(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `path/${folderId}`,
            );
            expect(path.sharingRestricted).toBe(false);
        });

        test('editor can modify ACL after owner unrestricts', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                remove: [CHARLIE_EMAIL],
            });
            expect(res.status).toBe(200);
        });
    });

    describe('viewer cannot modify ACL regardless of restriction', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Viewer Test Folder' },
            );
            folderId = folder.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: false }],
            });
        });

        test('viewer cannot modify ACL (no write, no restriction needed)', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folderId, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });
            expect(res.status).toBe(403);
        });
    });

    describe('inherited write access + restricted child', () => {
        let parentId: string;
        let childId: string;

        beforeAll(async () => {
            const parent = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Reshare Inherited Parent' },
            );
            parentId = parent.id;

            // Share parent with Bob (write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parentId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
            });

            // Create restricted child
            const child = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${parentId}`,
                { folderName: 'Restricted Child' },
            );
            childId = child.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${childId}/acl`, {
                sharingRestricted: true,
            });
        });

        test('Bob has inherited write on child', async () => {
            const write = await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, childId);
            expect(write.canWrite).toBe(true);
        });

        test('Bob is blocked from modifying ACL on restricted child despite inherited write', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, childId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: false }],
            });
            expect(res.status).toBe(403);
        });

        test('Bob can still create content in restricted child', async () => {
            const subfolder = await drivePost(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${childId}`,
                { folderName: 'Content OK' },
            );
            expect(subfolder.name).toBe('Content OK');
        });
    });

    describe('sharingRestricted propagates to shared_paths', () => {
        let folderId: string;

        beforeAll(async () => {
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Propagation Test' },
            );
            folderId = folder.id;

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                add: [{ id: BOB_EMAIL, read: true, write: true }],
                sharingRestricted: true,
            });
        });

        test('Bob sees sharingRestricted in shared-with-me', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === folderId);
            expect(shared.sharingRestricted).toBe(true);
        });

        test('sharingRestricted updates propagate', async () => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderId}/acl`, {
                sharingRestricted: false,
            });

            const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
            const data = await assertJson<DrivePath[]>(res);
            const shared = findOrFail(data, (item) => item.id === folderId);
            expect(shared.sharingRestricted).toBe(false);
        });
    });

    describe('team-owned paths', () => {
        let teamId: string;
        let teamOwner: string;
        let teamMountId: string;
        let teamRootId: string;
        let folderId: string;

        beforeAll(async () => {
            const config = getServerConfig();
            const orgId = config!.orgId;

            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ organizationId: orgId }),
            });

            const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Reshare Test Team', organizationId: orgId }),
            });
            const team = await assertJson<OrgTeam>(teamRes);
            teamId = team.id;
            teamOwner = teamOwnerId(teamId);

            // Add alice and bob to team
            for (const userId of [ctx.alice.user.id, ctx.bob.user.id]) {
                await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ teamId, userId }),
                });
            }

            // Create team mount
            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwner}/mount`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Reshare Team Drive', storageType: 'local', maxSizeMB: 500 }),
            });

            const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
            const mounts = await assertJson<MountInfo[]>(mountsRes);
            teamMountId = mounts[0].id;

            const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
            teamRootId = root.id;

            // Create folder and share with Charlie (non-team-member), then restrict
            const folder = await drivePost(
                ctx.alice.user.sessionToken,
                teamOwner,
                teamMountId,
                `folder/${teamRootId}`,
                { folderName: 'Team Restricted Folder' },
            );
            folderId = folder.id;

            await drivePut(ctx.alice.user.sessionToken, teamOwner, teamMountId, `path/${folderId}/acl`, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: true }],
                sharingRestricted: true,
            });
        });

        test('team member (alice) can modify ACL on restricted team path', async () => {
            const res = await putACL(ctx.alice.user.sessionToken, teamOwner, teamMountId, folderId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });
            expect(res.status).toBe(200);
        });

        test('team member (bob) can modify ACL on restricted team path', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, teamOwner, teamMountId, folderId, {
                add: [{ id: CHARLIE_EMAIL, read: true, write: true }],
            });
            expect(res.status).toBe(200);
        });

        test('team member can toggle sharingRestricted on team path', async () => {
            const res = await putACL(ctx.bob.user.sessionToken, teamOwner, teamMountId, folderId, {
                sharingRestricted: false,
            });
            expect(res.status).toBe(200);

            const path = await driveGet(ctx.bob.user.sessionToken, teamOwner, teamMountId, `path/${folderId}`);
            expect(path.sharingRestricted).toBe(false);

            // Re-restrict for next test
            await putACL(ctx.alice.user.sessionToken, teamOwner, teamMountId, folderId, {
                sharingRestricted: true,
            });
        });

        test('non-team-member editor (charlie) is blocked on restricted team path', async () => {
            const res = await putACL(ctx.charlie.user.sessionToken, teamOwner, teamMountId, folderId, {
                add: [{ id: 'external@example.com', read: true, write: false }],
            });
            expect(res.status).toBe(403);
        });

        test('non-team-member cannot toggle sharingRestricted on team path', async () => {
            const res = await putACL(ctx.charlie.user.sessionToken, teamOwner, teamMountId, folderId, {
                sharingRestricted: false,
            });
            expect(res.status).toBe(403);

            const path = await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, `path/${folderId}`);
            expect(path.sharingRestricted).toBe(true);
        });
    });
});
