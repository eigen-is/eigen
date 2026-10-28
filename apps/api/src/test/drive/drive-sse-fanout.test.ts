import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { SSEvent, SSEventDrive } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { getServerConfig } from '../../lib/config/server-config';
import { drainACLFanOuts } from '../../lib/drive/acl-propagation';
import type { SSECollector, TestContext, TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    authedRequest,
    collectSSE,
    createTeam,
    createTestUser,
    driveDelete,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

// A relayed event reaches other homes after the change answers, so a test that expects nothing waits
// this long after a member's copy arrived before it looks.
const SETTLE_MS = 50;

let ctx: TestContext;
let teamId: string;
let teamOwner: string;
let teamMountId: string;
let teamRoot: DrivePath;
let exMember: TestUser;

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function driveEvent(type: SSEventDrive['type'], pathId: string): (event: SSEvent) => event is SSEventDrive {
    return (event): event is SSEventDrive => event.type === type && 'path' in event && event.path.id === pathId;
}

function namedEvents(collector: SSECollector, pathId: string): SSEvent[] {
    return collector.events.filter((event) => 'path' in event && event.path.id === pathId);
}

async function createFolder(token: string, ownerId: string, mountId: string, parentId: string, folderName: string) {
    return drivePost(token, ownerId, mountId, `folder/${parentId}`, { folderName });
}

beforeAll(async () => {
    ctx = await getTestContext();
    const orgId = getServerConfig()?.orgId;
    if (!orgId) throw new Error('the server has no org');
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
    });
    // Alice and Bob are members. Charlie never is, and the ex-member leaves before the tests run.
    teamId = await createTeam(ctx, orgId, 'SSE Fanout Team');
    teamOwner = teamOwnerId(teamId);
    exMember = await createTestUser('sse-fanout-ex@test.eigen.is', 'testpassword123', 'Ex Member');
    await addMember(ctx, teamId, ctx.alice.user.id);
    await addMember(ctx, teamId, ctx.bob.user.id);
    await addMember(ctx, teamId, exMember.id);
    await addTeamMount(ctx, teamId, 'SSE Fanout Drive');
    teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
    teamRoot = await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, userId: exMember.id }),
    });
});

describe('a drive change on a team drive', () => {
    test("reaches a member's stream", async () => {
        const bobSSE = await collectSSE(ctx.bob.user.id);
        const folder = await createFolder(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            teamRoot.id,
            'sse-team-create',
        );
        await bobSSE.next(driveEvent(SSEventType.DRIVE_FOLDER_CREATED, folder.id));
        bobSSE.stop();
    });

    test('reaches no non-member and no ex-member', async () => {
        const bobSSE = await collectSSE(ctx.bob.user.id);
        const charlieSSE = await collectSSE(ctx.charlie.user.id);
        const exSSE = await collectSSE(exMember.id);
        const folder = await createFolder(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            teamRoot.id,
            'sse-team-private',
        );
        await bobSSE.next(driveEvent(SSEventType.DRIVE_FOLDER_CREATED, folder.id));
        await settle();
        for (const collector of [bobSSE, charlieSSE, exSSE]) collector.stop();

        expect(namedEvents(charlieSSE, folder.id)).toEqual([]);
        expect(namedEvents(exSSE, folder.id)).toEqual([]);
    });

    test("carries the path's ids and nothing more to a member", async () => {
        const bobSSE = await collectSSE(ctx.bob.user.id);
        const file = await driveUpload(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            teamRoot.id,
            new File(['team payload'], 'sse-team-payload.txt', { type: 'text/plain' }),
        );
        const isUploaded = driveEvent(SSEventType.DRIVE_FILE_UPLOADED, file.id);
        await bobSSE.next(isUploaded);
        bobSSE.stop();

        expect(bobSSE.events.find(isUploaded)?.path).toEqual({
            ownerId: teamOwner,
            mountId: teamMountId,
            id: file.id,
            parentId: teamRoot.id,
            mimeType: file.mimeType,
        });
    });
});

describe('a drive change inside a shared folder', () => {
    let aliceMountId: string;
    let aliceRoot: DrivePath;
    let privateFolder: DrivePath;
    let sharedFolder: DrivePath;

    beforeAll(async () => {
        const token = ctx.alice.user.sessionToken;
        aliceMountId = await firstMountId(token, ctx.alice.user.id);
        aliceRoot = await driveGet(token, ctx.alice.user.id, aliceMountId, 'root');
        // Bob can read the shared folder, but not the private folder around it.
        privateFolder = await createFolder(token, ctx.alice.user.id, aliceMountId, aliceRoot.id, 'sse-private');
        sharedFolder = await createFolder(token, ctx.alice.user.id, aliceMountId, privateFolder.id, 'sse-shared');
        await drivePut(token, ctx.alice.user.id, aliceMountId, `path/${sharedFolder.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        await drainACLFanOuts();
    });

    test("reaches the sharee's stream, and a change beside it does not", async () => {
        const token = ctx.alice.user.sessionToken;
        const bobSSE = await collectSSE(ctx.bob.user.id);
        const charlieSSE = await collectSSE(ctx.charlie.user.id);
        const beside = await createFolder(token, ctx.alice.user.id, aliceMountId, privateFolder.id, 'sse-beside');
        const inside = await driveUpload(
            token,
            ctx.alice.user.id,
            aliceMountId,
            sharedFolder.id,
            new File(['shared payload'], 'sse-inside.txt', { type: 'text/plain' }),
        );
        await bobSSE.next(driveEvent(SSEventType.DRIVE_FILE_UPLOADED, inside.id));
        await settle();
        bobSSE.stop();
        charlieSSE.stop();

        expect(namedEvents(bobSSE, beside.id)).toEqual([]);
        expect(namedEvents(charlieSSE, inside.id)).toEqual([]);
    });

    // An ACL entry may grant no read, and its holder cannot list the folder, so an event would name a path
    // they may not see.
    test('reaches no sharee who may not read the folder', async () => {
        const token = ctx.alice.user.sessionToken;
        const dropBox = await createFolder(token, ctx.alice.user.id, aliceMountId, aliceRoot.id, 'sse-write-only');
        await drivePut(token, ctx.alice.user.id, aliceMountId, `path/${dropBox.id}/acl`, {
            add: [{ id: ctx.charlie.user.email, read: false, write: true }],
        });
        await drainACLFanOuts();
        const aliceSSE = await collectSSE(ctx.alice.user.id);
        const charlieSSE = await collectSSE(ctx.charlie.user.id);
        const inside = await createFolder(token, ctx.alice.user.id, aliceMountId, dropBox.id, 'sse-write-only-inside');
        await aliceSSE.next(driveEvent(SSEventType.DRIVE_FOLDER_CREATED, inside.id));
        await settle();
        aliceSSE.stop();
        charlieSSE.stop();

        expect(namedEvents(charlieSSE, inside.id)).toEqual([]);
    });

    // After the move or the trash, Bob can no longer read the path. His open view of the shared folder
    // still lists it, so he hears that it left.
    test('tells the sharee that a path left the folder, by a move or a trash', async () => {
        const token = ctx.alice.user.sessionToken;
        const moved = await createFolder(token, ctx.alice.user.id, aliceMountId, sharedFolder.id, 'sse-moved');
        const trashed = await createFolder(token, ctx.alice.user.id, aliceMountId, sharedFolder.id, 'sse-trashed');
        const bobSSE = await collectSSE(ctx.bob.user.id);
        await drivePut(token, ctx.alice.user.id, aliceMountId, `path/${moved.id}/move`, {
            targetParentId: privateFolder.id,
        });
        await driveDelete(token, ctx.alice.user.id, aliceMountId, `path/${trashed.id}`);
        await bobSSE.next(driveEvent(SSEventType.DRIVE_PATH_MOVED, moved.id));
        await bobSSE.next(driveEvent(SSEventType.DRIVE_PATH_TRASHED, trashed.id));
        bobSSE.stop();
    });

    // The owner is one of the path's members, and hears each event once all the same.
    test("reaches the owner's stream once", async () => {
        const aliceSSE = await collectSSE(ctx.alice.user.id);
        const bobSSE = await collectSSE(ctx.bob.user.id);
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, `path/${sharedFolder.id}/rename`, {
            newName: 'sse-shared-renamed',
        });
        await bobSSE.next(driveEvent(SSEventType.DRIVE_FILE_HISTORY_UPDATED, sharedFolder.id));
        await settle();
        aliceSSE.stop();
        bobSSE.stop();

        const types = namedEvents(aliceSSE, sharedFolder.id).map((event) => event.type);
        expect(types.filter((type) => type === SSEventType.DRIVE_PATH_RENAMED)).toHaveLength(1);
        expect(types.filter((type) => type === SSEventType.DRIVE_FILE_HISTORY_UPDATED)).toHaveLength(1);
    });
});
