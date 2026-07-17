import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../lib/config/server-config';
import { getHome } from '../lib/home/get-home';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    driveDelete,
    driveGet,
    driveGetList,
    driveUpload,
    firstMountId,
    getTestContext,
} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('Chat wizard — Chats folder', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('seeds a Chats folder in a fresh user default mount root', async () => {
        const mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const children = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}`,
        );

        const chats = children.find((c) => c.name === 'Chats');
        expect(chats).toBeDefined();
        expect(chats!.type).toBe('folder');
    });

    test('does not seed a Chats folder in a team drive root', async () => {
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        const teamId = await createTeam(ctx, orgId, 'Chat Wizard Team');
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addTeamMount(ctx, teamId, 'Team Drive');

        const teamOwner = teamOwnerId(teamId);
        const teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
        const root = await driveGet(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const children = await driveGetList(ctx.alice.user.sessionToken, teamOwner, teamMountId, `folder/${root.id}`);

        expect(children.find((c) => c.name === 'Chats')).toBeUndefined();
    });

    test('ensureChatsFolder recreates the folder after it is trashed', async () => {
        const mountId = await firstMountId(ctx.bob.user.sessionToken, ctx.bob.user.id);
        const root = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, 'root');
        const before = await driveGetList(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `folder/${root.id}`);

        const seeded = before.find((c) => c.name === 'Chats');
        expect(seeded).toBeDefined();
        await driveDelete(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `path/${seeded!.id}`);

        const home = await getHome(ctx.bob.user.id);
        const chatsId = await home.drive.ensureChatsFolder(mountId);
        expect(chatsId).not.toBe(seeded!.id);

        const after = await driveGetList(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `folder/${root.id}`);
        const chatsFolders = after.filter((c) => c.name === 'Chats');
        expect(chatsFolders).toHaveLength(1);
        expect(chatsFolders[0].id).toBe(chatsId);
        expect(chatsFolders[0].type).toBe('folder');
    });

    test('ensureChatsFolder falls back to the root when Chats is a non-folder', async () => {
        const mountId = await firstMountId(ctx.charlie.user.sessionToken, ctx.charlie.user.id);
        const root = await driveGet(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, 'root');
        const before = await driveGetList(
            ctx.charlie.user.sessionToken,
            ctx.charlie.user.id,
            mountId,
            `folder/${root.id}`,
        );

        const seeded = before.find((c) => c.name === 'Chats');
        expect(seeded).toBeDefined();
        await driveDelete(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, `path/${seeded!.id}`);

        const file = new File(['not a folder'], 'Chats', { type: 'text/plain' });
        await driveUpload(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, root.id, file);

        const home = await getHome(ctx.charlie.user.id);
        const result = await home.drive.ensureChatsFolder(mountId);
        expect(result).toBe(root.id);

        // Nothing renamed or created: still exactly one untrashed `Chats`, still the non-folder file.
        const after = await driveGetList(
            ctx.charlie.user.sessionToken,
            ctx.charlie.user.id,
            mountId,
            `folder/${root.id}`,
        );
        const named = after.filter((c) => c.name === 'Chats');
        expect(named).toHaveLength(1);
        expect(named[0].type).not.toBe('folder');
    });
});
