import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getServerConfig } from '../../lib/config/server-config';
import { REFERENCE_READER_VERSION } from '../../lib/document/references';
import type { Drive } from '../../lib/drive/drive';
import { getHome } from '../../lib/home/get-home';
import type { Mount } from '../../lib/mount/mount';
import { getVersionReferences, putVersionReferences } from '../../lib/mount/version-references';
import { getUserById } from '../../lib/user';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    createTestGuest,
    driveGet,
    drivePost,
    drivePut,
    firstMountId,
    getTestContext,
} from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// Delete history: an owner of the drive deletes every version of a document and of its comment threads.
describe('DELETE .../file/:pathId/versions', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let aliceRootId: string;
    let teamOwner: string;
    let teamMountId: string;
    let teamRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceMountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        aliceRootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root'))
            .id;

        const orgId = getServerConfig()?.orgId;
        if (!orgId) throw new Error('no org');
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, 'Delete History Team');
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addMember(ctx, teamId, ctx.bob.user.id);
        await addTeamMount(ctx, teamId, 'Delete History Drive');
        teamOwner = teamOwnerId(teamId);
        teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
        teamRootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root')).id;
    });

    // A doc with two versions and one comment thread with a version of its own, on the owner's drive.
    async function docWithHistory(ownerId: string, mountId: string, rootId: string) {
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ownerId,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: `history-${crypto.randomUUID()}` },
        );
        const drive = (await getHome(ownerId)).drive;
        const { mount } = await drive.resolveFile(mountId, doc.id);
        await drive.saveVersion(mountId, doc.id);
        await drive.saveVersion(mountId, doc.id);
        const chat = await mount.getChildByName(doc.id, 'chat');
        if (!chat) throw new Error('no chat folder');
        const thread = await drive.create(mountId, chat.id, `thread-${crypto.randomUUID()}`, 'chat');
        const author = await getUserById(ctx.alice.user.id);
        if (!author) throw new Error('no author');
        await (await drive.getChat(mountId, thread.id)).postMessage(author, 'hello');
        await drive.saveVersion(mountId, thread.id);
        expect(await versionIds(mount, doc.id)).toHaveLength(2);
        expect(await versionIds(mount, thread.id)).toHaveLength(1);
        return { doc, thread, drive, mount };
    }

    function deleteVersions(token: string, ownerId: string, mountId: string, pathId: string): Promise<Response> {
        return authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/versions`, { method: 'DELETE' });
    }

    test('the owner deletes every version of the document and of its threads, and their rows', async () => {
        const owner = ctx.alice.user;
        const { doc, thread, mount } = await docWithHistory(owner.id, aliceMountId, aliceRootId);
        const ids = [...(await versionIds(mount, doc.id)), ...(await versionIds(mount, thread.id))];
        const names = { media: ['a.png'], chat: [], cards: [] };
        putVersionReferences(
            mount,
            ids.map((versionPathId) => ({ versionPathId, readerVersion: REFERENCE_READER_VERSION, names })),
        );
        expect(getVersionReferences(mount, ids)).toHaveLength(3);

        const res = await deleteVersions(owner.sessionToken, owner.id, aliceMountId, doc.id);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(await versionIds(mount, doc.id)).toEqual([]);
        expect(await versionIds(mount, thread.id)).toEqual([]);
        expect(getVersionReferences(mount, ids)).toEqual([]);
        const list = await authedRequest(
            owner.sessionToken,
            `/drive/${owner.id}/${aliceMountId}/file/${doc.id}/versions`,
        );
        expect(await list.json()).toEqual([]);
    });

    test('a restore of a deleted version answers 404', async () => {
        const owner = ctx.alice.user;
        const { doc, drive } = await docWithHistory(owner.id, aliceMountId, aliceRootId);
        const [version] = await drive.listVersions(aliceMountId, doc.id);
        await deleteVersions(owner.sessionToken, owner.id, aliceMountId, doc.id);

        const res = await authedRequest(
            owner.sessionToken,
            `/drive/${owner.id}/${aliceMountId}/file/${doc.id}/versions/${version.name}/restore`,
            { method: 'POST' },
        );
        expect(res.status).toBe(404);
    });

    test('an editor who does not own the drive gets 403, and so does a reader, and nothing goes', async () => {
        const owner = ctx.alice.user;
        const { doc, thread, mount } = await docWithHistory(owner.id, aliceMountId, aliceRootId);
        await drivePut(owner.sessionToken, owner.id, aliceMountId, `path/${doc.id}/acl`, {
            add: [
                { id: ctx.bob.user.email, read: true, write: true },
                { id: ctx.charlie.user.email, read: true, write: false },
            ],
        });

        for (const visitor of [ctx.bob.user, ctx.charlie.user]) {
            const res = await deleteVersions(visitor.sessionToken, owner.id, aliceMountId, doc.id);
            expect(res.status).toBe(403);
        }
        expect(await versionIds(mount, doc.id)).toHaveLength(2);
        expect(await versionIds(mount, thread.id)).toHaveLength(1);
    });

    test('every member of a team deletes the history of a team document', async () => {
        const { doc, thread, mount } = await docWithHistory(teamOwner, teamMountId, teamRootId);

        const res = await deleteVersions(ctx.bob.user.sessionToken, teamOwner, teamMountId, doc.id);
        expect(res.status).toBe(200);
        expect(await versionIds(mount, doc.id)).toEqual([]);
        expect(await versionIds(mount, thread.id)).toEqual([]);
    });

    // Every account of the organization is a member of its default team, so each of them owns that team's drive.
    test('a member of the default team deletes the history of its documents, and a guest gets 403', async () => {
        const defaultTeamId = getServerConfig()?.defaultTeamId;
        if (!defaultTeamId) throw new Error('no default team');
        const owner = teamOwnerId(defaultTeamId);
        await addTeamMount(ctx, defaultTeamId, 'Default Team Drive');
        const mountId = await firstMountId(ctx.alice.user.sessionToken, owner);
        const rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, owner, mountId, 'root')).id;
        const guest = await createTestGuest('History Guest');
        const shared = await docWithHistory(owner, mountId, rootId);
        await drivePut(ctx.alice.user.sessionToken, owner, mountId, `path/${shared.doc.id}/acl`, {
            add: [{ id: guest.email, read: true, write: true }],
        });

        const refused = await deleteVersions(guest.sessionToken, owner, mountId, shared.doc.id);
        expect(refused.status).toBe(403);
        expect(await versionIds(shared.mount, shared.doc.id)).toHaveLength(2);

        const res = await deleteVersions(ctx.charlie.user.sessionToken, owner, mountId, shared.doc.id);
        expect(res.status).toBe(200);
        expect(await versionIds(shared.mount, shared.doc.id)).toEqual([]);
        expect(await versionIds(shared.mount, shared.thread.id)).toEqual([]);
    });

    test('a versions folder whose name differs in case goes too', async () => {
        const owner = ctx.alice.user;
        const doc = await drivePost<DrivePath>(
            owner.sessionToken,
            owner.id,
            aliceMountId,
            `folder/${aliceRootId}/create/doc`,
            { fileName: `history-${crypto.randomUUID()}` },
        );
        const drive = (await getHome(owner.id)).drive;
        const { mount } = await drive.resolveFile(aliceMountId, doc.id);
        // The lookup a save makes ignores case, so the version lands in this folder.
        await mount.createFolder(doc.id, 'Versions');
        await drive.saveVersion(aliceMountId, doc.id);
        expect(await versionIds(mount, doc.id)).toHaveLength(1);

        const res = await deleteVersions(owner.sessionToken, owner.id, aliceMountId, doc.id);
        expect(res.status).toBe(200);
        expect(await mount.getChildByName(doc.id, 'versions')).toBeNull();
    });

    test('a folder that is not a document keeps a child named versions', async () => {
        const owner = ctx.alice.user;
        const folder = await drivePost<DrivePath>(owner.sessionToken, owner.id, aliceMountId, `folder/${aliceRootId}`, {
            folderName: `plain-${crypto.randomUUID()}`,
        });
        const child = await drivePost<DrivePath>(owner.sessionToken, owner.id, aliceMountId, `folder/${folder.id}`, {
            folderName: 'versions',
        });

        const res = await deleteVersions(owner.sessionToken, owner.id, aliceMountId, folder.id);
        expect(res.status).toBe(400);
        const drive: Drive = (await getHome(owner.id)).drive;
        expect((await drive.getPath(aliceMountId, child.id))?.id).toBe(child.id);
    });
});

async function versionIds(mount: Mount, containerId: string): Promise<string[]> {
    const versions = await mount.getChildByName(containerId, 'versions');
    return versions ? (await mount.listFolder(versions.id)).map((file) => file.id) : [];
}
