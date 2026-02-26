import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';
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
