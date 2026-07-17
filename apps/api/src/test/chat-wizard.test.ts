import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { ChatMatch } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
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
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
} from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

async function createChat(
    token: string,
    ownerId: string,
    mountId: string,
    parentId: string,
    fileName: string,
): Promise<string> {
    const chat = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${parentId}/create/chat`, { fileName });
    return chat.id;
}

function updateAcl(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    body: Record<string, unknown>,
): Promise<Response> {
    return authedRequest(token, `/drive/${ownerId}/${mountId}/path/${pathId}/acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function byMembers(token: string, ownerId: string, emails: string): Promise<ChatMatch[]> {
    const res = await authedRequest(token, `/chat/${ownerId}/rooms/by-members?emails=${encodeURIComponent(emails)}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { matches: ChatMatch[] }).matches;
}

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

describe('Chat wizard — by-members matching', () => {
    let ctx: TestCtx;
    let mountId: string;
    let rootId: string;
    let aliceEmail: string;
    let bobEmail: string;
    let charlieEmail: string;
    let teamAclId: string;

    // Chats reused across tests (create-order matters — see the shared context DB).
    let oneToOneId: string;
    let groupId: string;
    let sharedWritableId: string;
    let sharedReadonlyId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceEmail = ctx.alice.user.email;
        bobEmail = ctx.bob.user.email;
        charlieEmail = ctx.charlie.user.email;

        mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;

        // A real team so the team-ACL exclusion test uses a valid team entry.
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, 'By-Members Team');
        await addMember(ctx, teamId, ctx.alice.user.id);
        teamAclId = teamOwnerId(teamId);
    });

    test('matches an exact 1:1 chat and marks it writable', async () => {
        oneToOneId = await createChat(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, 'Alice & Bob');
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, oneToOneId, {
            add: [{ id: bobEmail, read: true, write: true }],
        });

        const matches = await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, bobEmail);
        expect(matches).toHaveLength(1);
        expect(matches[0].path.id).toBe(oneToOneId);
        expect(matches[0].canWrite).toBe(true);
    });

    test('treats the chat owner as an implicit member (self is never in the ACL)', async () => {
        const matches = await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, bobEmail);
        const match = matches.find((m) => m.path.id === oneToOneId);
        expect(match).toBeDefined();
        // The query never named alice and alice is not an ACL entry — the match relies on the
        // owner being folded into the effective member set implicitly.
        expect(match!.path.acl?.some((e) => e.id === aliceEmail)).toBeFalsy();
    });

    test('matches an own chat whose members are inherited from a shared parent folder', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'Shared Space' },
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, folder.id, {
            add: [{ id: bobEmail, read: true, write: true }],
        });
        const inheritedId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            folder.id,
            'Inherited',
        );

        const matches = await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, bobEmail);
        const match = matches.find((m) => m.path.id === inheritedId);
        expect(match).toBeDefined();
        expect(match!.canWrite).toBe(true);
        // No direct ACL — the members come purely from the shared parent (effective-members walk).
        expect(match!.path.acl ?? []).toHaveLength(0);
    });

    test('does not match on a subset or superset of members', async () => {
        groupId = await createChat(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, 'Alice Bob Carol');
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, groupId, {
            add: [
                { id: bobEmail, read: true, write: true },
                { id: charlieEmail, read: true, write: true },
            ],
        });

        // Superset query (bob + charlie) must not return the alice+bob 1:1 chat.
        const superset = await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, `${bobEmail},${charlieEmail}`);
        expect(superset.some((m) => m.path.id === oneToOneId)).toBe(false);
        expect(superset.some((m) => m.path.id === groupId)).toBe(true);

        // Subset query (bob) must not return the alice+bob+charlie group chat.
        const subset = await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, bobEmail);
        expect(subset.some((m) => m.path.id === groupId)).toBe(false);
        expect(subset.some((m) => m.path.id === oneToOneId)).toBe(true);
    });

    test('excludes team-ACL, non-private, and trashed chats', async () => {
        // A chat with a team_* ACL entry — dynamic membership, never a fixed set of people.
        const teamChatId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            'Team Entry',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, teamChatId, {
            add: [
                { id: bobEmail, read: true, write: true },
                { id: teamAclId, read: true, write: true },
            ],
        });

        // A public-read chat — a public link means unbounded membership.
        const publicChatId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            'Public',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, publicChatId, {
            add: [{ id: bobEmail, read: true, write: true }],
            visibility: 'public-read',
        });

        // A trashed chat — never listed at all.
        const trashedChatId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            'Trashed',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, trashedChatId, {
            add: [{ id: bobEmail, read: true, write: true }],
        });
        await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${trashedChatId}`);

        const ids = (await byMembers(ctx.alice.user.sessionToken, ctx.alice.user.id, bobEmail)).map((m) => m.path.id);
        expect(ids).not.toContain(teamChatId);
        expect(ids).not.toContain(publicChatId);
        expect(ids).not.toContain(trashedChatId);
        // Sanity: a plain private direct chat with the same members still matches.
        expect(ids).toContain(oneToOneId);
    });

    test('matches chats shared with me and reflects my write permission', async () => {
        sharedWritableId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            'Shared Writable',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, sharedWritableId, {
            add: [{ id: bobEmail, read: true, write: true }],
        });

        sharedReadonlyId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            'Shared Readonly',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, sharedReadonlyId, {
            add: [{ id: bobEmail, read: true, write: false }],
        });

        // Bob resolves the same chats through his shared-with-me mirror; his ACL entry decides canWrite.
        const matches = await byMembers(ctx.bob.user.sessionToken, ctx.bob.user.id, aliceEmail);
        const writable = matches.find((m) => m.path.id === sharedWritableId);
        const readonly = matches.find((m) => m.path.id === sharedReadonlyId);
        expect(writable).toBeDefined();
        expect(writable!.canWrite).toBe(true);
        expect(readonly).toBeDefined();
        expect(readonly!.canWrite).toBe(false);
    });

    test('orders writable matches before read-only matches', async () => {
        const matches = await byMembers(ctx.bob.user.sessionToken, ctx.bob.user.id, aliceEmail);
        const writableIndex = matches.findIndex((m) => m.path.id === sharedWritableId);
        const readonlyIndex = matches.findIndex((m) => m.path.id === sharedReadonlyId);
        expect(writableIndex).toBeGreaterThanOrEqual(0);
        expect(readonlyIndex).toBeGreaterThanOrEqual(0);
        expect(writableIndex).toBeLessThan(readonlyIndex);

        // Every read-only match sorts after every writable one.
        const lastWritable = matches.reduce((acc, m, i) => (m.canWrite ? i : acc), -1);
        const firstReadonly = matches.findIndex((m) => !m.canWrite);
        if (firstReadonly >= 0) expect(lastWritable).toBeLessThan(firstReadonly);
    });

    test('returns 400 when emails is missing or empty', async () => {
        const missing = await authedRequest(ctx.alice.user.sessionToken, `/chat/${ctx.alice.user.id}/rooms/by-members`);
        expect(missing.status).toBe(400);

        const empty = await authedRequest(
            ctx.alice.user.sessionToken,
            `/chat/${ctx.alice.user.id}/rooms/by-members?emails=`,
        );
        expect(empty.status).toBe(400);

        const blank = await authedRequest(
            ctx.alice.user.sessionToken,
            `/chat/${ctx.alice.user.id}/rooms/by-members?emails=${encodeURIComponent(' , ')}`,
        );
        expect(blank.status).toBe(400);
    });
});
