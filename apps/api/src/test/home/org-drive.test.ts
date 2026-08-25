import { beforeAll, describe, expect, test } from 'bun:test';
import { type MountInfo, type OrgTeam, teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../../lib/config/server-config';
import type { TextPreviewResult } from '../../lib/preview/text-preview';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetPermission,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
    type PermissionResult,
    TEST_PNG_BYTES,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

async function addTeamMount(sessionToken: string, teamId: string, name = 'Team Drive') {
    return authedRequest(sessionToken, `/team/${teamOwnerId(teamId)}/mount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, storageType: 'local', maxSizeMB: 500 }),
    });
}

describe('Team Drives', () => {
    let ctx: TestCtx;
    let orgId: string;
    let teamId: string;
    let teamOwner: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        // Set active org first
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // Create a team
        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Drive Test Team', organizationId: orgId }),
        });
        const team = await assertJson<OrgTeam>(teamRes);
        teamId = team.id;
        teamOwner = teamOwnerId(teamId);

        // Add alice to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.alice.user.id }),
        });

        // Add bob to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        await addTeamMount(ctx.alice.user.sessionToken, teamId);
    });

    test('team drive has mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        expect(mounts.length).toBeGreaterThan(0);
    });

    test('team drive has root folder with team owner ID', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        expect(root).not.toBeNull();
        expect(root.type).toBe('folder');
        expect(root.ownerId).toBe(teamOwner);
    });

    test('create folder in team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const folder = await drivePost(ctx.alice.user.sessionToken, teamOwner, mountId, `folder/${root.id}`, {
            folderName: 'Team Docs',
        });
        expect(folder.name).toBe('Team Docs');
        expect(folder.ownerId).toBe(teamOwner);
        expect(folder.type).toBe('folder');
    });

    test('upload file to team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const file = new File(['team file content'], 'team-readme.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, teamOwner, mountId, root.id, file);
        expect(uploaded.name).toBe('team-readme.txt');
        expect(uploaded.ownerId).toBe(teamOwner);
    });

    test('team member (bob) can read team drive root', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.bob.user.sessionToken, teamOwner, mountId, 'root');
        expect(root).not.toBeNull();
        expect(root.type).toBe('folder');
    });

    test('team member (bob) can create folder in team drive', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.bob.user.sessionToken, teamOwner, mountId, 'root');
        const folder = await drivePost(ctx.bob.user.sessionToken, teamOwner, mountId, `folder/${root.id}`, {
            folderName: 'Bob Team Folder',
        });
        expect(folder.name).toBe('Bob Team Folder');
        expect(folder.ownerId).toBe(teamOwner);
    });

    test('non-team member (charlie) cannot read team drive root', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;

        const rootRes = await authedRequest(ctx.charlie.user.sessionToken, `/drive/${teamOwner}/${mountId}/root`);
        const body = await rootRes.text();
        expect(body === '' || body === 'null').toBe(true);
    });

    test('non-team member (charlie) cannot write to team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        const mountId = mounts[0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');

        const permRes = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/path/${root.id}/permissions`,
        );
        const result = await assertJson<PermissionResult>(permRes);
        expect(result.canWrite).toBe(false);
    });

    test('text-preview works on team drive file', async () => {
        const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mountId = (await assertJson<MountInfo[]>(mountsRes))[0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const file = new File(['Hello from team'], 'team-preview.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, teamOwner, mountId, root.id, file);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/file/${uploaded.id}/text-preview`,
        );
        const data = await assertJson<TextPreviewResult>(res);
        expect(data.body).toContain('Hello from team');
        expect(data.mode).toBe('plaintext');
    });

    test('preview works on team drive image file', async () => {
        const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mountId = (await assertJson<MountInfo[]>(mountsRes))[0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const file = new File([TEST_PNG_BYTES], 'team-image.png', { type: 'image/png' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, teamOwner, mountId, root.id, file);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/file/${uploaded.id}/preview`,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
    });

    test('team member (bob) can access text-preview on team drive', async () => {
        const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const mountId = (await assertJson<MountInfo[]>(mountsRes))[0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const file = new File(['Bob can read this'], 'bob-preview.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, teamOwner, mountId, root.id, file);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/file/${uploaded.id}/text-preview`,
        );
        const data = await assertJson<TextPreviewResult>(res);
        expect(data.body).toContain('Bob can read this');
    });
});

describe('Team ACL on personal drive', () => {
    let ctx: TestCtx;
    let orgId: string;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ACL Test Team', organizationId: orgId }),
        });
        const team = await assertJson<OrgTeam>(teamRes);
        teamId = team.id;

        // Add bob to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });
    });

    test('team member can read folder shared with team ACL', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await assertJson<MountInfo[]>(aliceMountsRes);
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Team Shared Folder' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: `team_${teamId}`, read: true, write: false }],
            visibility: 'private',
        });

        const bobRead = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        const bobResult = await assertJson<PermissionResult>(bobRead);
        expect(bobResult.canRead).toBe(true);
    });

    test('non-team member denied access to team-shared folder', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await assertJson<MountInfo[]>(aliceMountsRes);
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Team Only Folder' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: `team_${teamId}`, read: true, write: false }],
            visibility: 'private',
        });

        const charlieRead = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        const charlieResult = await assertJson<PermissionResult>(charlieRead);
        expect(charlieResult.canRead).toBe(false);
    });

    test('team ACL write permission works for team member', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await assertJson<MountInfo[]>(aliceMountsRes);
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Team Write Folder' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: `team_${teamId}`, read: true, write: true }],
            visibility: 'private',
        });

        const bobWrite = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        const bobResult = await assertJson<PermissionResult>(bobWrite);
        expect(bobResult.canWrite).toBe(true);
    });

    test('individual ACL + team ACL are additive', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await assertJson<MountInfo[]>(aliceMountsRes);
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Additive ACL Folder' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [
                { id: `team_${teamId}`, read: true, write: false },
                { id: 'charlie@test.eigen.is', read: true, write: true },
            ],
            visibility: 'private',
        });

        // Charlie (individual write) can write
        const charlieWrite = await authedRequest(
            ctx.charlie.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        expect((await assertJson<PermissionResult>(charlieWrite)).canWrite).toBe(true);

        // Bob (team read only) can read but not write
        const bobRead = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        expect((await assertJson<PermissionResult>(bobRead)).canRead).toBe(true);

        const bobWrite = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions`,
        );
        expect((await assertJson<PermissionResult>(bobWrite)).canWrite).toBe(false);
    });
});

describe('Redundant ACL filtering', () => {
    let ctx: TestCtx;
    let orgId: string;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        const res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const mounts = await assertJson<MountInfo[]>(res);
        aliceMountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    test('ACL for user already inherited from parent is stripped', async () => {
        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Inherited Parent' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parent.id}/acl`, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Inherited Child' },
        );

        // Set ACL on child granting bob read (redundant — inherited from parent)
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        const childData = await driveGet(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `path/${child.id}`,
        );
        expect(childData.acl).toBeNull();
    });

    test('ACL with broader permissions than inherited is kept', async () => {
        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Read Only Parent' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parent.id}/acl`, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Write Child' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: true }],
            visibility: 'private',
        });

        const childData = await driveGet(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `path/${child.id}`,
        );
        expect(childData.acl).not.toBeNull();
        expect(childData.acl!.length).toBe(1);
        expect(childData.acl![0].write).toBe(true);
    });

    test('team ACL on team-owned path is stripped (team already has access via ownership)', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Redundant ACL Team', organizationId: orgId }),
        });
        const team = await assertJson<OrgTeam>(teamRes);
        const tOwner = teamOwnerId(team.id);

        // Add alice to the team so she can access the team drive
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team.id, userId: ctx.alice.user.id }),
        });

        await addTeamMount(ctx.alice.user.sessionToken, team.id);

        const tmRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${tOwner}/mounts`);
        const teamMounts = await assertJson<MountInfo[]>(tmRes);
        const teamMountId = teamMounts[0].id;
        const teamRoot = await driveGet(ctx.alice.user.sessionToken, tOwner, teamMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken, tOwner, teamMountId, `folder/${teamRoot.id}`, {
            folderName: 'Team ACL Test',
        });

        // Set ACL for the SAME team on a path inside team drive (redundant)
        await drivePut(ctx.alice.user.sessionToken, tOwner, teamMountId, `path/${folder.id}/acl`, {
            add: [{ id: `team_${team.id}`, read: true, write: true }],
            visibility: 'private',
        });

        const folderData = await driveGet(ctx.alice.user.sessionToken, tOwner, teamMountId, `path/${folder.id}`);
        expect(folderData.acl).toBeNull();
    });

    test('team ACL on parent is inherited — child team ACL is stripped', async () => {
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Inherited Team ACL', organizationId: orgId }),
        });
        const team = await assertJson<OrgTeam>(teamRes);

        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Team Inherited Parent' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parent.id}/acl`, {
            add: [{ id: `team_${team.id}`, read: true, write: true }],
            visibility: 'private',
        });

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Team Inherited Child' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: `team_${team.id}`, read: true, write: false }],
            visibility: 'private',
        });

        const childData = await driveGet(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `path/${child.id}`,
        );
        expect(childData.acl).toBeNull();
    });

    test('user ACL not covered by inheritance is kept', async () => {
        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'No Inherited Parent' },
        );

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Has ACL Child' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        const childData = await driveGet(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `path/${child.id}`,
        );
        expect(childData.acl).not.toBeNull();
        expect(childData.acl!.length).toBe(1);
        expect(childData.acl![0].id).toBe('charlie@test.eigen.is');
    });
});

describe('Team Drive Security Edge Cases', () => {
    let ctx: TestCtx;
    let orgId: string;
    let teamId: string;
    let teamOwner: string;
    let teamMountId: string;
    let teamRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Security Test Team', organizationId: orgId }),
        });
        const team = await assertJson<OrgTeam>(teamRes);
        teamId = team.id;
        teamOwner = teamOwnerId(teamId);

        // Add alice and bob to team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.alice.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        await addTeamMount(ctx.alice.user.sessionToken, teamId);

        const tmRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${teamOwner}/mounts`);
        const teamMounts = await assertJson<MountInfo[]>(tmRes);
        teamMountId = teamMounts[0].id;
        teamRootId = (await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root')).id;
    });

    test('non-team member cannot access team drive root', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/drive/${teamOwner}/${teamMountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);
    });

    test('team member can create nested folders in team drive', async () => {
        const folder1 = await drivePost(ctx.bob.user.sessionToken, teamOwner, teamMountId, `folder/${teamRootId}`, {
            folderName: 'Bob Team Folder',
        });
        expect(folder1.ownerId).toBe(teamOwner);

        const folder2 = await drivePost(ctx.bob.user.sessionToken, teamOwner, teamMountId, `folder/${folder1.id}`, {
            folderName: 'Bob Nested Folder',
        });
        expect(folder2.ownerId).toBe(teamOwner);
    });

    test('team member can upload files to team drive', async () => {
        const file = new File(['team file content'], 'team-file.txt', { type: 'text/plain' });
        const uploaded = await driveUpload(ctx.bob.user.sessionToken, teamOwner, teamMountId, teamRootId, file);
        expect(uploaded.ownerId).toBe(teamOwner);
        expect(uploaded.name).toBe('team-file.txt');
    });

    test('team member cannot modify team drive ROOT ACL', async () => {
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${teamRootId}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
                }),
            },
        );
        expect(res.status).toBe(403); // Forbidden for team members modifying root ACL
    });

    test('team member CAN modify ACL of folder inside team drive', async () => {
        // Create a folder inside team drive
        const folder = await drivePost(ctx.bob.user.sessionToken, teamOwner, teamMountId, `folder/${teamRootId}`, {
            folderName: 'Team Folder',
        });

        // Bob should be able to modify this folder's ACL
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${folder.id}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
                }),
            },
        );
        expect(res.status).toBe(200); // Allowed for team members modifying subfolder ACL
    });

    test('team member cannot modify team drive ROOT ACL (Alice also blocked)', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${teamRootId}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
                }),
            },
        );
        expect(res.status).toBe(403); // Even team members cannot modify root ACL
    });

    test('removing team member revokes team drive access', async () => {
        // Remove bob from team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        // Bob can no longer access team drive
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${teamOwner}/${teamMountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);

        // Re-add bob for subsequent tests
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });
    });

    // NOTE: Team deletion test removed - team deletion not yet implemented in API
});

describe('Cross-Team Access Edge Cases', () => {
    let ctx: TestCtx;
    let orgId: string;
    let team1Id: string;
    let team2Id: string;
    let team1Owner: string;
    let team2Owner: string;
    let team1MountId: string;
    let team2MountId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // Create two teams
        const team1Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Cross Team 1', organizationId: orgId }),
        });
        team1Id = (await assertJson<OrgTeam>(team1Res)).id;
        team1Owner = teamOwnerId(team1Id);

        const team2Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Cross Team 2', organizationId: orgId }),
        });
        team2Id = (await assertJson<OrgTeam>(team2Res)).id;
        team2Owner = teamOwnerId(team2Id);

        // Add alice to both teams, bob only to team1, charlie only to team2
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team1Id, userId: ctx.alice.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team2Id, userId: ctx.alice.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team1Id, userId: ctx.bob.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team2Id, userId: ctx.charlie.user.id }),
        });

        await addTeamMount(ctx.alice.user.sessionToken, team1Id, 'Cross Team 1 Drive');
        await addTeamMount(ctx.alice.user.sessionToken, team2Id, 'Cross Team 2 Drive');

        const t1Res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${team1Owner}/mounts`);
        team1MountId = (await assertJson<MountInfo[]>(t1Res))[0].id;

        const t2Res = await authedRequest(ctx.alice.user.sessionToken, `/drive/${team2Owner}/mounts`);
        team2MountId = (await assertJson<MountInfo[]>(t2Res))[0].id;
    });

    test('team member cannot access other team drives', async () => {
        // Bob (team1) cannot access team2 drive
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${team2Owner}/${team2MountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);

        // Charlie (team2) cannot access team1 drive
        const res2 = await authedRequest(ctx.charlie.user.sessionToken, `/drive/${team1Owner}/${team1MountId}/root`);
        const body2 = await res2.text();
        expect(body2 === '' || body2 === 'null').toBe(true);
    });

    test('user in multiple teams can access all their team drives', async () => {
        // Alice is in both teams, should access both
        const t1Root = await driveGet(ctx.alice.user.sessionToken, team1Owner, team1MountId, 'root');
        const t2Root = await driveGet(ctx.alice.user.sessionToken, team2Owner, team2MountId, 'root');

        expect(t1Root).not.toBeNull();
        expect(t2Root).not.toBeNull();
        expect(t1Root.ownerId).toBe(team1Owner);
        expect(t2Root.ownerId).toBe(team2Owner);
    });

    test('team1 member with ACL access to team2 folder can access', async () => {
        const team2Root = await driveGet(ctx.alice.user.sessionToken, team2Owner, team2MountId, 'root');

        // Alice gives Bob read access to a folder in team2
        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            team2Owner,
            team2MountId,
            `folder/${team2Root.id}`,
            { folderName: 'Cross Team Folder' },
        );

        await drivePut(ctx.alice.user.sessionToken, team2Owner, team2MountId, `path/${folder.id}/acl`, {
            add: [{ id: 'bob@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        // Bob can now read the folder despite not being in team2
        const bobRead = await driveGetPermission(ctx.bob.user.sessionToken, team2Owner, team2MountId, folder.id);
        expect(bobRead.canRead).toBe(true);

        // But Bob still can't read the team2 root
        const bobRootRead = await driveGetPermission(ctx.bob.user.sessionToken, team2Owner, team2MountId, team2Root.id);
        expect(bobRootRead.canRead).toBe(false);
    });

    test('team ACL on personal drive allows cross-team access', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMountId = (await assertJson<MountInfo[]>(aliceMountsRes))[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        // Alice shares folder with team2
        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Team2 Shared' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [{ id: `team_${team2Id}`, read: true, write: true }],
            visibility: 'private',
        });

        // Charlie (team2 member) can access
        const charlieRead = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        expect(charlieRead.canRead).toBe(true);

        // Bob (not in team2) cannot access
        const bobRead = await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folder.id);
        expect(bobRead.canRead).toBe(false);
    });

    test('complex cross-team permission inheritance', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMountId = (await assertJson<MountInfo[]>(aliceMountsRes))[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');

        // Create nested structure: parent (team1 ACL) -> child (team2 ACL) -> grandchild
        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRoot.id}`,
            { folderName: 'Cross Parent' },
        );

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Cross Child' },
        );

        const grandchild = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${child.id}`,
            { folderName: 'Cross Grandchild' },
        );

        // Team1 ACL on parent, Team2 ACL on child
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parent.id}/acl`, {
            add: [{ id: `team_${team1Id}`, read: true, write: false }],
            visibility: 'private',
        });

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: `team_${team2Id}`, read: true, write: true }],
            visibility: 'private',
        });

        // Bob (team1) should have read from parent, write from child doesn't apply
        const bobReadParent = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            parent.id,
        );
        const bobReadChild = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            child.id,
        );
        const bobWriteGrandchild = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            grandchild.id,
        );

        expect(bobReadParent.canRead).toBe(true);
        expect(bobReadChild.canRead).toBe(true); // Inherits from parent
        expect(bobWriteGrandchild.canWrite).toBe(false); // No write access

        // Charlie (team2) should have write from child down
        const charlieReadParent = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            parent.id,
        );
        const charlieWriteChild = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            child.id,
        );
        const charlieWriteGrandchild = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            grandchild.id,
        );

        expect(charlieReadParent.canRead).toBe(false); // No access to parent
        expect(charlieWriteChild.canWrite).toBe(true); // Direct ACL on child
        expect(charlieWriteGrandchild.canWrite).toBe(true); // Inherits from child
    });
});

describe('Team ACL Edge Cases with Personal Drives', () => {
    let ctx: TestCtx;
    let orgId: string;
    let teamId: string;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ACL Edge Team', organizationId: orgId }),
        });
        teamId = (await assertJson<OrgTeam>(teamRes)).id;

        // Add bob and charlie to team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.charlie.user.id }),
        });

        const mountsRes = await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/mounts`);
        aliceMountId = (await assertJson<MountInfo[]>(mountsRes))[0].id;
        aliceRootId = (await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root')).id;
    });

    test('team ACL + individual ACL on same path', async () => {
        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Mixed ACL' },
        );

        // Set both team and individual ACL
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [
                { id: `team_${teamId}`, read: true, write: false },
                { id: 'charlie@test.eigen.is', read: true, write: true },
            ],
            visibility: 'private',
        });

        // Bob (team) should have read-only
        const bobRead = await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folder.id);
        const bobWrite = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        expect(bobRead.canRead).toBe(true);
        expect(bobWrite.canWrite).toBe(false);

        // Charlie should have write (individual ACL overrides team read-only)
        const charlieRead = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        const charlieWrite = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        expect(charlieRead.canRead).toBe(true);
        expect(charlieWrite.canWrite).toBe(true);
    });

    test('team ACL inheritance with individual restrictions', async () => {
        const parent = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Team Parent' },
        );

        const child = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${parent.id}`,
            { folderName: 'Restricted Child' },
        );

        // Team ACL on parent (write), individual restriction on child (read-only for Charlie)
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${parent.id}/acl`, {
            add: [{ id: `team_${teamId}`, read: true, write: true }],
            visibility: 'private',
        });

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${child.id}/acl`, {
            add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
            visibility: 'private',
        });

        // Bob should have write on child (inherits from parent)
        const bobWriteChild = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            child.id,
        );
        expect(bobWriteChild.canWrite).toBe(true);

        // Charlie should have write (team ACL adds to individual ACL in additive model)
        const charlieWriteChild = await driveGetPermission(
            ctx.charlie.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            child.id,
        );
        expect(charlieWriteChild.canWrite).toBe(true); // Additive model: team write + individual read = write
    });

    test('removing user from team revokes team ACL access but keeps individual ACL', async () => {
        const folder = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            `folder/${aliceRootId}`,
            { folderName: 'Team Removal Test' },
        );

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folder.id}/acl`, {
            add: [
                { id: `team_${teamId}`, read: true, write: true },
                { id: 'bob@test.eigen.is', read: true, write: false },
            ],
            visibility: 'private',
        });

        // Bob has both team and individual access
        const bobRead = await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, aliceMountId, folder.id);
        expect(bobRead.canRead).toBe(true);

        // Remove bob from team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        // Bob should still have read access via individual ACL
        const bobReadAfter = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        const bobWriteAfter = await driveGetPermission(
            ctx.bob.user.sessionToken,
            ctx.alice.user.id,
            aliceMountId,
            folder.id,
        );
        expect(bobReadAfter.canRead).toBe(true);
        expect(bobWriteAfter.canWrite).toBe(false); // Only read from individual ACL

        // Re-add bob for cleanup
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });
    });

    test('team ACL on deleted team is treated as invalid', async () => {
        await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `folder/${aliceRootId}`, {
            folderName: 'Deleted Team Test',
        });

        // NOTE: Team deletion test removed - team deletion not yet implemented in API
        // TODO: Add this test back when team deletion is properly implemented
        // This test was checking that deleted team drives become inaccessible
    });

    describe('Team ACL Additive Model Validation', () => {
        let folderA: string;
        let folderB: string;

        beforeAll(async () => {
            const a = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${aliceRootId}`,
                { folderName: 'Team Additive A' },
            );
            folderA = a.id;

            const b = await drivePost(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                `folder/${folderA}`,
                { folderName: 'Team Additive B' },
            );
            folderB = b.id;
        });

        test('team additive model: team ACL at parent + individual ACL at child', async () => {
            // Team ACL at A (write), individual ACL for Charlie at B (read)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                add: [{ id: `team_${teamId}`, read: true, write: true }],
                visibility: 'private',
            });

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                add: [{ id: 'charlie@test.eigen.is', read: true, write: false }],
                visibility: 'private',
            });

            // Bob (team member) should have write at B (inherits from team ACL at A)
            const bobWriteB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderB,
            );
            expect(bobWriteB.canWrite).toBe(true);

            // Charlie should have write at B (team write + individual read = write)
            const charlieWriteB = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderB,
            );
            expect(charlieWriteB.canWrite).toBe(true);
        });

        test('team additive model: multiple teams with overlapping permissions', async () => {
            // Create second team
            const team2Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Additive Team 2', organizationId: orgId }),
            });
            const team2Id = (await assertJson<OrgTeam>(team2Res)).id;

            // Add Charlie to second team
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team2Id, userId: ctx.charlie.user.id }),
            });

            // Team1 ACL at A (read), Team2 ACL at B (write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                add: [{ id: `team_${teamId}`, read: true, write: false }],
                visibility: 'private',
            });

            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderB}/acl`, {
                add: [{ id: `team_${team2Id}`, read: true, write: true }],
                visibility: 'private',
            });

            // Charlie (in both teams) should have write at B (additive: read from team1 + write from team2)
            const charlieWriteB = await driveGetPermission(
                ctx.charlie.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderB,
            );
            expect(charlieWriteB.canWrite).toBe(true);

            // Bob (only in team1) should have read at A, no write at B
            const bobReadA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderA,
            );
            const bobWriteB = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderB,
            );
            expect(bobReadA.canRead).toBe(true);
            expect(bobWriteB.canWrite).toBe(false);

            // Cleanup
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId: team2Id }),
            });
        });

        test('team additive model: team member removed loses team ACL access', async () => {
            // Team ACL at A (write)
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${folderA}/acl`, {
                add: [{ id: `team_${teamId}`, read: true, write: true }],
                visibility: 'private',
            });

            // Bob should have write at A
            const bobWriteA = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderA,
            );
            expect(bobWriteA.canWrite).toBe(true);

            // Remove Bob from team
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
            });

            // Bob should lose access to A
            const bobWriteAAfter = await driveGetPermission(
                ctx.bob.user.sessionToken,
                ctx.alice.user.id,
                aliceMountId,
                folderA,
            );
            expect(bobWriteAAfter.canWrite).toBe(false);

            // Re-add Bob for cleanup
            await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
            });
        });
    });
});
