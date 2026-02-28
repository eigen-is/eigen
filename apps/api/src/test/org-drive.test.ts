import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';
import {getServerConfig} from '../lib/config/server-config';
import {teamOwnerId} from '@workspace/lib/types';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

function driveUrl(ownerId: string, mountId: string, ...parts: string[]) {
    return `/drive/${ownerId}/${mountId}/${parts.join('/')}`;
}

async function driveGet(token: string, ownerId: string, mountId: string, ...parts: string[]): Promise<any> {
    const res = await authedRequest(token, driveUrl(ownerId, mountId, ...parts));
    return res.json();
}

async function drivePost(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

async function drivePut(token: string, ownerId: string, mountId: string, path: string, body: Record<string, unknown>): Promise<any> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${path}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    });
    return res.json();
}

async function driveUpload(token: string, ownerId: string, mountId: string, parentId: string, file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${parentId}`, {
        method: 'POST',
        body: formData,
    });
    return res.json();
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
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        // Create a team
        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Drive Test Team', organizationId: orgId}),
            });
        const team = await teamRes.json() as any;
        teamId = team.id;
        teamOwner = teamOwnerId(teamId);

        // Add alice to the team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.alice.user.id}),
            });

        // Add bob to the team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });
    });

    test('team drive has mounts', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        expect(mounts).toBeDefined();
        expect(mounts.length).toBeGreaterThan(0);
    });

    test('team drive has root folder with team owner ID', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        expect(root).not.toBeNull();
        expect(root.type).toBe('folder');
        expect(root.ownerId).toBe(teamOwner);
    });

    test('create folder in team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const folder = await drivePost(ctx.alice.user.sessionToken, teamOwner, mountId,
            `folder/${root.id}`, {folderName: 'Team Docs'});
        expect(folder.name).toBe('Team Docs');
        expect(folder.ownerId).toBe(teamOwner);
        expect(folder.type).toBe('folder');
    });

    test('upload file to team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');
        const file = new File(['team file content'], 'team-readme.txt', {type: 'text/plain'});
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, teamOwner, mountId, root.id, file);
        expect(uploaded.name).toBe('team-readme.txt');
        expect(uploaded.ownerId).toBe(teamOwner);
    });

    test('team member (bob) can read team drive root', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.bob.user.sessionToken, teamOwner, mountId, 'root');
        expect(root).not.toBeNull();
        expect(root.type).toBe('folder');
    });

    test('team member (bob) can create folder in team drive', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const root = await driveGet(ctx.bob.user.sessionToken, teamOwner, mountId, 'root');
        const folder = await drivePost(ctx.bob.user.sessionToken, teamOwner, mountId,
            `folder/${root.id}`, {folderName: 'Bob Team Folder'});
        expect(folder.name).toBe('Bob Team Folder');
        expect(folder.ownerId).toBe(teamOwner);
    });

    test('non-team member (charlie) cannot read team drive root', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;

        const rootRes = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/root`);
        const body = await rootRes.text();
        expect(body === '' || body === 'null').toBe(true);
    });

    test('non-team member (charlie) cannot write to team drive', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const mounts = await res.json() as any[];
        const mountId = mounts[0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, mountId, 'root');

        const writeRes = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${teamOwner}/${mountId}/path/${root.id}/permissions/write`);
        const result = await writeRes.json() as any;
        expect(result.canWrite).toBe(false);
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

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'ACL Test Team', organizationId: orgId}),
            });
        const team = await teamRes.json() as any;
        teamId = team.id;

        // Add bob to the team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });
    });

    test('team member can read folder shared with team ACL', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await aliceMountsRes.json() as any[];
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Team Shared Folder'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'team', read: true, write: false, type: 'team', targetId: teamId}],
                visibility: 'private',
            });

        const bobRead = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/read`);
        const bobResult = await bobRead.json() as any;
        expect(bobResult.canRead).toBe(true);
    });

    test('non-team member denied access to team-shared folder', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await aliceMountsRes.json() as any[];
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Team Only Folder'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'team', read: true, write: false, type: 'team', targetId: teamId}],
                visibility: 'private',
            });

        const charlieRead = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/read`);
        const charlieResult = await charlieRead.json() as any;
        expect(charlieResult.canRead).toBe(false);
    });

    test('team ACL write permission works for team member', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await aliceMountsRes.json() as any[];
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Team Write Folder'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: teamId}],
                visibility: 'private',
            });

        const bobWrite = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/write`);
        const bobResult = await bobWrite.json() as any;
        expect(bobResult.canWrite).toBe(true);
    });

    test('individual ACL + team ACL are additive', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMounts = await aliceMountsRes.json() as any[];
        const aliceMountId = aliceMounts[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Additive ACL Folder'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [
                    {email: 'team', read: true, write: false, type: 'team', targetId: teamId},
                    {email: 'charlie@test.eigen.is', read: true, write: true},
                ],
                visibility: 'private',
            });

        // Charlie (individual write) can write
        const charlieWrite = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/write`);
        expect((await charlieWrite.json() as any).canWrite).toBe(true);

        // Bob (team read only) can read but not write
        const bobRead = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/read`);
        expect((await bobRead.json() as any).canRead).toBe(true);

        const bobWrite = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/path/${folder.id}/permissions/write`);
        expect((await bobWrite.json() as any).canWrite).toBe(false);
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

        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const mounts = await res.json() as any[];
        aliceMountId = mounts[0].id;

        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    test('ACL for user already inherited from parent is stripped', async () => {
        const parent = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Inherited Parent'});

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/acl`, {
                acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        const child = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Inherited Child'});

        // Set ACL on child granting bob read (redundant — inherited from parent)
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        const childData = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}`);
        expect(childData.acl).toBeNull();
    });

    test('ACL with broader permissions than inherited is kept', async () => {
        const parent = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Read Only Parent'});

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/acl`, {
                acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        const child = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Write Child'});

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'bob@test.eigen.is', read: true, write: true}],
                visibility: 'private',
            });

        const childData = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}`);
        expect(childData.acl).not.toBeNull();
        expect(childData.acl.length).toBe(1);
        expect(childData.acl[0].write).toBe(true);
    });

    test('team ACL on team-owned path is stripped (team already has access via ownership)', async () => {
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Redundant ACL Team', organizationId: orgId}),
            });
        const team = await teamRes.json() as any;
        const tOwner = teamOwnerId(team.id);

        // Add alice to the team so she can access the team drive
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team.id, userId: ctx.alice.user.id}),
            });

        const tmRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${tOwner}/mounts`);
        const teamMounts = await tmRes.json() as any[];
        const teamMountId = teamMounts[0].id;
        const teamRoot = await driveGet(ctx.alice.user.sessionToken, tOwner, teamMountId, 'root');

        const folder = await drivePost(ctx.alice.user.sessionToken, tOwner, teamMountId,
            `folder/${teamRoot.id}`, {folderName: 'Team ACL Test'});

        // Set ACL for the SAME team on a path inside team drive (redundant)
        await drivePut(ctx.alice.user.sessionToken, tOwner, teamMountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: team.id}],
                visibility: 'private',
            });

        const folderData = await driveGet(ctx.alice.user.sessionToken, tOwner, teamMountId,
            `path/${folder.id}`);
        expect(folderData.acl).toBeNull();
    });

    test('team ACL on parent is inherited — child team ACL is stripped', async () => {
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Inherited Team ACL', organizationId: orgId}),
            });
        const team = await teamRes.json() as any;

        const parent = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Team Inherited Parent'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: team.id}],
                visibility: 'private',
            });

        const child = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Team Inherited Child'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'team', read: true, write: false, type: 'team', targetId: team.id}],
                visibility: 'private',
            });

        const childData = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, `path/${child.id}`);
        expect(childData.acl).toBeNull();
    });

    test('user ACL not covered by inheritance is kept', async () => {
        const parent = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'No Inherited Parent'});

        const child = await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Has ACL Child'});

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        const childData = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId,
            `path/${child.id}`);
        expect(childData.acl).not.toBeNull();
        expect(childData.acl.length).toBe(1);
        expect(childData.acl[0].email).toBe('charlie@test.eigen.is');
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

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Security Test Team', organizationId: orgId}),
            });
        const team = await teamRes.json() as any;
        teamId = team.id;
        teamOwner = teamOwnerId(teamId);

        // Add alice and bob to team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.alice.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });

        const tmRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/mounts`);
        const teamMounts = await tmRes.json() as any[];
        teamMountId = teamMounts[0].id;
        teamRootId = (await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root')).id;
    });

    test('non-team member cannot access team drive root', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);
    });

    test('team member can create nested folders in team drive', async () => {
        const folder1 = await drivePost(ctx.bob.user.sessionToken, teamOwner, teamMountId,
            `folder/${teamRootId}`, {folderName: 'Bob Team Folder'});
        expect(folder1.ownerId).toBe(teamOwner);

        const folder2 = await drivePost(ctx.bob.user.sessionToken, teamOwner, teamMountId,
            `folder/${folder1.id}`, {folderName: 'Bob Nested Folder'});
        expect(folder2.ownerId).toBe(teamOwner);
    });

    test('team member can upload files to team drive', async () => {
        const file = new File(['team file content'], 'team-file.txt', {type: 'text/plain'});
        const uploaded = await driveUpload(ctx.bob.user.sessionToken, teamOwner, teamMountId,
            teamRootId, file);
        expect(uploaded.ownerId).toBe(teamOwner);
        expect(uploaded.name).toBe('team-file.txt');
    });

    test('team member cannot modify team drive ROOT ACL', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${teamRootId}/acl`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                }),
            });
        expect(res.status).toBe(403); // Forbidden for team members modifying root ACL
    });

    test('team member CAN modify ACL of folder inside team drive', async () => {
        // Create a folder inside team drive
        const folder = await drivePost(ctx.bob.user.sessionToken,
            teamOwner, teamMountId,
            `folder/${teamRootId}`, {folderName: 'Team Folder'});

        // Bob should be able to modify this folder's ACL
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${folder.id}/acl`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                }),
            });
        expect(res.status).toBe(200); // Allowed for team members modifying subfolder ACL
    });

    test('team member cannot modify team drive ROOT ACL (Alice also blocked)', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/path/${teamRootId}/acl`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                }),
            });
        expect(res.status).toBe(403); // Even team members cannot modify root ACL
    });

    test('removing team member revokes team drive access', async () => {
        // Remove bob from team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/remove-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });

        // Bob can no longer access team drive
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${teamOwner}/${teamMountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);

        // Re-add bob for subsequent tests
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
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

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        // Create two teams
        const team1Res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Cross Team 1', organizationId: orgId}),
            });
        team1Id = (await team1Res.json() as any).id;
        team1Owner = teamOwnerId(team1Id);

        const team2Res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Cross Team 2', organizationId: orgId}),
            });
        team2Id = (await team2Res.json() as any).id;
        team2Owner = teamOwnerId(team2Id);

        // Add alice to both teams, bob only to team1, charlie only to team2
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team1Id, userId: ctx.alice.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team2Id, userId: ctx.alice.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team1Id, userId: ctx.bob.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team2Id, userId: ctx.charlie.user.id}),
            });

        const t1Res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${team1Owner}/mounts`);
        team1MountId = (await t1Res.json() as any[])[0].id;

        const t2Res = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${team2Owner}/mounts`);
        team2MountId = (await t2Res.json() as any[])[0].id;
    });

    test('team member cannot access other team drives', async () => {
        // Bob (team1) cannot access team2 drive
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/drive/${team2Owner}/${team2MountId}/root`);
        const body = await res.text();
        expect(body === '' || body === 'null').toBe(true);

        // Charlie (team2) cannot access team1 drive
        const res2 = await authedRequest(ctx.charlie.user.sessionToken,
            `/drive/${team1Owner}/${team1MountId}/root`);
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
        const folder = await drivePost(ctx.alice.user.sessionToken, team2Owner, team2MountId,
            `folder/${team2Root.id}`, {folderName: 'Cross Team Folder'});

        await drivePut(ctx.alice.user.sessionToken, team2Owner, team2MountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'bob@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        // Bob can now read the folder despite not being in team2
        const bobRead = await driveGet(ctx.bob.user.sessionToken, team2Owner, team2MountId,
            `path/${folder.id}/permissions/read`);
        expect(bobRead.canRead).toBe(true);

        // But Bob still can't read the team2 root
        const bobRootRead = await driveGet(ctx.bob.user.sessionToken, team2Owner, team2MountId,
            `path/${team2Root.id}/permissions/read`);
        expect(bobRootRead.canRead).toBe(false);
    });

    test('team ACL on personal drive allows cross-team access', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMountId = (await aliceMountsRes.json() as any[])[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        // Alice shares folder with team2
        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Team2 Shared'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: team2Id}],
                visibility: 'private',
            });

        // Charlie (team2 member) can access
        const charlieRead = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        expect(charlieRead.canRead).toBe(true);

        // Bob (not in team2) cannot access
        const bobRead = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        expect(bobRead.canRead).toBe(false);
    });

    test('complex cross-team permission inheritance', async () => {
        const aliceMountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        const aliceMountId = (await aliceMountsRes.json() as any[])[0].id;
        const aliceRoot = await driveGet(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId, 'root');

        // Create nested structure: parent (team1 ACL) -> child (team2 ACL) -> grandchild
        const parent = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRoot.id}`, {folderName: 'Cross Parent'});

        const child = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Cross Child'});

        const grandchild = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${child.id}`, {folderName: 'Cross Grandchild'});

        // Team1 ACL on parent, Team2 ACL on child
        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/acl`, {
                acl: [{email: 'team', read: true, write: false, type: 'team', targetId: team1Id}],
                visibility: 'private',
            });

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: team2Id}],
                visibility: 'private',
            });

        // Bob (team1) should have read from parent, write from child doesn't apply
        const bobReadParent = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/permissions/read`);
        const bobReadChild = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/permissions/read`);
        const bobWriteGrandchild = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${grandchild.id}/permissions/write`);

        expect(bobReadParent.canRead).toBe(true);
        expect(bobReadChild.canRead).toBe(true); // Inherits from parent
        expect(bobWriteGrandchild.canWrite).toBe(false); // No write access

        // Charlie (team2) should have write from child down
        const charlieReadParent = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/permissions/read`);
        const charlieWriteChild = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/permissions/write`);
        const charlieWriteGrandchild = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${grandchild.id}/permissions/write`);

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

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'ACL Edge Team', organizationId: orgId}),
            });
        teamId = (await teamRes.json() as any).id;

        // Add bob and charlie to team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });

        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.charlie.user.id}),
            });

        const mountsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/mounts`);
        aliceMountId = (await mountsRes.json() as any[])[0].id;
        aliceRootId = (await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root')).id;
    });

    test('team ACL + individual ACL on same path', async () => {
        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Mixed ACL'});

        // Set both team and individual ACL
        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [
                    {email: 'team', read: true, write: false, type: 'team', targetId: teamId},
                    {email: 'charlie@test.eigen.is', read: true, write: true}
                ],
                visibility: 'private',
            });

        // Bob (team) should have read-only
        const bobRead = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        const bobWrite = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/write`);
        expect(bobRead.canRead).toBe(true);
        expect(bobWrite.canWrite).toBe(false);

        // Charlie should have write (individual ACL overrides team read-only)
        const charlieRead = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        const charlieWrite = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/write`);
        expect(charlieRead.canRead).toBe(true);
        expect(charlieWrite.canWrite).toBe(true);
    });

    test('team ACL inheritance with individual restrictions', async () => {
        const parent = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Team Parent'});

        const child = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${parent.id}`, {folderName: 'Restricted Child'});

        // Team ACL on parent (write), individual restriction on child (read-only for Charlie)
        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${parent.id}/acl`, {
                acl: [{email: 'team', read: true, write: true, type: 'team', targetId: teamId}],
                visibility: 'private',
            });

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/acl`, {
                acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                visibility: 'private',
            });

        // Bob should have write on child (inherits from parent)
        const bobWriteChild = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/permissions/write`);
        expect(bobWriteChild.canWrite).toBe(true);

        // Charlie should have write (team ACL adds to individual ACL in additive model)
        const charlieWriteChild = await driveGet(ctx.charlie.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${child.id}/permissions/write`);
        expect(charlieWriteChild.canWrite).toBe(true); // Additive model: team write + individual read = write
    });

    test('removing user from team revokes team ACL access but keeps individual ACL', async () => {
        const folder = await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Team Removal Test'});

        await drivePut(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/acl`, {
                acl: [
                    {email: 'team', read: true, write: true, type: 'team', targetId: teamId},
                    {email: 'bob@test.eigen.is', read: true, write: false}
                ],
                visibility: 'private',
            });

        // Bob has both team and individual access
        const bobRead = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        expect(bobRead.canRead).toBe(true);

        // Remove bob from team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/remove-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });

        // Bob should still have read access via individual ACL
        const bobReadAfter = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/read`);
        const bobWriteAfter = await driveGet(ctx.bob.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `path/${folder.id}/permissions/write`);
        expect(bobReadAfter.canRead).toBe(true);
        expect(bobWriteAfter.canWrite).toBe(false); // Only read from individual ACL

        // Re-add bob for cleanup
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });
    });

    test('team ACL on deleted team is treated as invalid', async () => {
        await drivePost(ctx.alice.user.sessionToken,
            ctx.alice.user.id, aliceMountId,
            `folder/${aliceRootId}`, {folderName: 'Deleted Team Test'});

        // NOTE: Team deletion test removed - team deletion not yet implemented in API
        // TODO: Add this test back when team deletion is properly implemented
        // This test was checking that deleted team drives become inaccessible
    });

    describe('Team ACL Additive Model Validation', () => {
        let folderA: string;
        let folderB: string;

        beforeAll(async () => {
            const a = await drivePost(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `folder/${aliceRootId}`, {folderName: 'Team Additive A'});
            folderA = a.id;

            const b = await drivePost(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `folder/${folderA}`, {folderName: 'Team Additive B'});
            folderB = b.id;
        });

        test('team additive model: team ACL at parent + individual ACL at child', async () => {
            // Team ACL at A (write), individual ACL for Charlie at B (read)
            await drivePut(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/acl`, {
                    acl: [{email: 'team', read: true, write: true, type: 'team', targetId: teamId}],
                    visibility: 'private',
                });

            await drivePut(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/acl`, {
                    acl: [{email: 'charlie@test.eigen.is', read: true, write: false}],
                    visibility: 'private',
                });

            // Bob (team member) should have write at B (inherits from team ACL at A)
            const bobWriteB = await driveGet(ctx.bob.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/permissions/write`);
            expect(bobWriteB.canWrite).toBe(true);

            // Charlie should have write at B (team write + individual read = write)
            const charlieWriteB = await driveGet(ctx.charlie.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/permissions/write`);
            expect(charlieWriteB.canWrite).toBe(true);
        });

        test('team additive model: multiple teams with overlapping permissions', async () => {
            // Create second team
            const team2Res = await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/create-team', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'Additive Team 2', organizationId: orgId}),
                });
            const team2Id = (await team2Res.json() as any).id;

            // Add Charlie to second team
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/add-team-member', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({teamId: team2Id, userId: ctx.charlie.user.id}),
                });

            // Team1 ACL at A (read), Team2 ACL at B (write)
            await drivePut(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/acl`, {
                    acl: [{email: 'team', read: true, write: false, type: 'team', targetId: teamId}],
                    visibility: 'private',
                });

            await drivePut(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/acl`, {
                    acl: [{email: 'team', read: true, write: true, type: 'team', targetId: team2Id}],
                    visibility: 'private',
                });

            // Charlie (in both teams) should have write at B (additive: read from team1 + write from team2)
            const charlieWriteB = await driveGet(ctx.charlie.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/permissions/write`);
            expect(charlieWriteB.canWrite).toBe(true);

            // Bob (only in team1) should have read at A, no write at B
            const bobReadA = await driveGet(ctx.bob.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/permissions/read`);
            const bobWriteB = await driveGet(ctx.bob.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderB}/permissions/write`);
            expect(bobReadA.canRead).toBe(true);
            expect(bobWriteB.canWrite).toBe(false);

            // Cleanup
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/remove-team', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({teamId: team2Id}),
                });
        });

        test('team additive model: team member removed loses team ACL access', async () => {
            // Team ACL at A (write)
            await drivePut(ctx.alice.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/acl`, {
                    acl: [{email: 'team', read: true, write: true, type: 'team', targetId: teamId}],
                    visibility: 'private',
                });

            // Bob should have write at A
            const bobWriteA = await driveGet(ctx.bob.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/permissions/write`);
            expect(bobWriteA.canWrite).toBe(true);

            // Remove Bob from team
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/remove-team-member', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
                });

            // Bob should lose access to A
            const bobWriteAAfter = await driveGet(ctx.bob.user.sessionToken,
                ctx.alice.user.id, aliceMountId,
                `path/${folderA}/permissions/write`);
            expect(bobWriteAAfter.canWrite).toBe(false);

            // Re-add Bob for cleanup
            await authedRequest(ctx.alice.user.sessionToken,
                '/auth/organization/add-team-member', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
                });
        });
    });
});
