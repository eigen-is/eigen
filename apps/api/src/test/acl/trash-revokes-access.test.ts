import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getServerConfig } from '../../lib/config/server-config';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    driveGet,
    driveGetPermission,
    drivePost,
    drivePut,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

// Trash takes access away from everyone but the owner, and restore gives it back unchanged.
describe('Trash revokes access', () => {
    let ctx: TestCtx;
    let rootId: string;
    // A doc shared with Bob directly, a folder shared with Bob with a doc inside it, and a doc nobody
    // shared, which is what Bob's answers are compared with.
    let doc: DrivePath;
    let folder: DrivePath;
    let inner: DrivePath;
    let unshared: DrivePath;
    let publicDoc: DrivePath;

    function bob(path: string, init?: RequestInit): Promise<Response> {
        return authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.alice.user.id}/${MOUNT}/${path}`, init);
    }

    function reshare(pathId: string): Promise<Response> {
        return bob(`path/${pathId}/acl`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ add: [{ id: ctx.charlie.user.email, read: true, write: false }] }),
        });
    }

    // What Bob gets for each way in, as status and body, so a trashed item can be compared with one he
    // was never given.
    async function answers(pathId: string): Promise<string[]> {
        const responses = [
            await bob(`path/${pathId}`),
            await bob(`path/${pathId}/effective-members`),
            await bob(`path/${pathId}/permissions`),
            await reshare(pathId),
            await bob(`file/${pathId}/versions/save`, { method: 'POST' }),
        ];
        return Promise.all(responses.map(async (res) => `${res.status} ${await res.text()}`));
    }

    async function trash(pathId: string): Promise<void> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT}/path/${pathId}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
    }

    async function restore(pathId: string): Promise<void> {
        await drivePost(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, `trash/${pathId}/restore`, {});
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const token = ctx.alice.user.sessionToken;
        const aliceId = ctx.alice.user.id;
        rootId = (await driveGet<DrivePath>(token, aliceId, MOUNT, 'root')).id;
        const share = { add: [{ id: ctx.bob.user.email, read: true, write: true }] };

        doc = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}/create/doc`, {
            fileName: `trash-revokes-${randomUUID()}`,
        });
        await drivePut(token, aliceId, MOUNT, `path/${doc.id}/acl`, share);

        folder = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}`, {
            folderName: `trash-revokes-${randomUUID()}`,
        });
        await drivePut(token, aliceId, MOUNT, `path/${folder.id}/acl`, share);
        inner = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${folder.id}/create/doc`, {
            fileName: `inner-${randomUUID()}`,
        });

        unshared = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}/create/doc`, {
            fileName: `unshared-${randomUUID()}`,
        });

        publicDoc = await drivePost<DrivePath>(token, aliceId, MOUNT, `folder/${rootId}/create/doc`, {
            fileName: `public-${randomUUID()}`,
        });
        await drivePut(token, aliceId, MOUNT, `path/${publicDoc.id}/acl`, { visibility: 'public-read' });

        await trash(doc.id);
        await trash(folder.id);
        await trash(publicDoc.id);
    });

    test('a sharee gets for a trashed doc what he gets for a doc he was never given', async () => {
        const expected = (await answers(unshared.id)).map((answer) => answer.replace(unshared.id, doc.id));
        expect(await answers(doc.id)).toEqual(expected);
    });

    test('a sharee gets the same for a doc inside a trashed folder', async () => {
        const expected = (await answers(unshared.id)).map((answer) => answer.replace(unshared.id, inner.id));
        expect(await answers(inner.id)).toEqual(expected);
        expect((await bob(`folder/${folder.id}`)).status).toBe(403);
    });

    test('a stranger gets for a trashed public-read doc what he gets for a doc he was never given', async () => {
        const expected = (await answers(unshared.id)).map((answer) => answer.replace(unshared.id, publicDoc.id));
        expect(await answers(publicDoc.id)).toEqual(expected);
    });

    test('the re-share was refused, so the ACL is unchanged', async () => {
        const after = await driveGet<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `path/${doc.id}`,
        );
        expect(after.acl?.map((entry) => entry.id)).toEqual([ctx.bob.user.email]);
    });

    test('the owner can not share a trashed doc either', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT}/path/${doc.id}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ add: [{ id: ctx.charlie.user.email, read: true, write: false }] }),
            },
        );
        expect(res.status).toBe(404);
    });

    test('a sharee can not leave a trashed doc, and gets the 403 of a doc he was never given', async () => {
        expect((await bob(`path/${doc.id}`, { method: 'DELETE' })).status).toBe(403);
    });

    test('the owner still reads them', async () => {
        const token = ctx.alice.user.sessionToken;
        const permissions = await driveGetPermission(token, ctx.alice.user.id, MOUNT, inner.id);
        expect(permissions).toEqual({ canRead: true, canWrite: true });
    });

    test('after a restore the sharee reads them again', async () => {
        await restore(doc.id);
        await restore(folder.id);
        expect((await bob(`path/${doc.id}`)).status).toBe(200);
        expect((await bob(`path/${inner.id}`)).status).toBe(200);
        const permissions = await driveGetPermission(ctx.bob.user.sessionToken, ctx.alice.user.id, MOUNT, doc.id);
        expect(permissions).toEqual({ canRead: true, canWrite: true });
    });
});

// A team's drive belongs to its members, so trash does not take it from them.
describe('Trash keeps a team drive readable for its members', () => {
    test('a team member reads a trashed item, a stranger does not', async () => {
        const ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, 'Trash Team');
        const owner = teamOwnerId(teamId);
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addMember(ctx, teamId, ctx.charlie.user.id);
        await addTeamMount(ctx, teamId, 'Trash Team Drive');
        const token = ctx.charlie.user.sessionToken;
        const mountId = await firstMountId(token, owner);
        const rootId = (await driveGet<DrivePath>(token, owner, mountId, 'root')).id;
        const item = await drivePost<DrivePath>(token, owner, mountId, `folder/${rootId}/create/doc`, {
            fileName: `team-trash-${randomUUID()}`,
        });

        const del = await authedRequest(token, `/drive/${owner}/${mountId}/path/${item.id}`, { method: 'DELETE' });
        expect(del.status).toBe(200);

        const member = await authedRequest(token, `/drive/${owner}/${mountId}/path/${item.id}`);
        expect(member.status).toBe(200);
        const permissions = await driveGetPermission(token, owner, mountId, item.id);
        expect(permissions.canRead).toBe(true);
        const stranger = await authedRequest(ctx.bob.user.sessionToken, `/drive/${owner}/${mountId}/path/${item.id}`);
        expect(stranger.status).toBe(403);
    });
});
