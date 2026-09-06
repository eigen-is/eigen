import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { teamOwnerId } from '@workspace/lib/types';
import type { ChatMatch } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    driveDelete,
    driveGet,
    driveGetList,
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

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

// A throwaway user with a fresh default mount — isolates folder-migration tests from the shared trio.
async function signUpFreshUser(label: string): Promise<{ id: string; token: string }> {
    const email = `chats-${label}-${randomUUID()}@test.eigen.is`;
    const password = 'testpassword123';
    const signUp = await auth.api.signUpEmail({ body: { email, password, name: `Chats ${label}` } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
    const token = (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';
    return { id: signUp.user.id, token };
}

describe('Chat wizard — chats folder', () => {
    let ctx: TestCtx;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('seeds a chats folder in a fresh user default mount root', async () => {
        const mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        const children = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${root.id}`,
        );

        const chats = children.find((c) => c.name === 'chats');
        expect(chats).toBeDefined();
        expect(chats!.type).toBe('folder');
    });

    test('migrates a legacy `Chats` folder to `chats` in place, reusing the same pathId', async () => {
        const u = await signUpFreshUser('legacy');
        const mountId = await firstMountId(u.token, u.id);
        const root = await driveGet(u.token, u.id, mountId, 'root');
        const before = await driveGetList(u.token, u.id, mountId, `folder/${root.id}`);

        const seeded = before.find((c) => c.name === 'chats' && c.type === 'folder');
        expect(seeded).toBeDefined();

        // Reproduce the legacy uppercase name the folder shipped with before this rename.
        const home = await getHome(u.id);
        await home.drive.renamePath(mountId, seeded!.id, 'Chats');

        const migratedId = await home.drive.ensureChatsFolder(mountId);
        expect(migratedId).toBe(seeded!.id); // renamed in place, not recreated

        const after = await driveGetList(u.token, u.id, mountId, `folder/${root.id}`);
        expect(after.find((c) => c.id === seeded!.id)?.name).toBe('chats');
        expect(after.filter((c) => c.name === 'chats' && c.type === 'folder')).toHaveLength(1);
    });

    test('does not seed a chats folder in a team drive root', async () => {
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

        expect(children.find((c) => c.name === 'chats')).toBeUndefined();
    });

    test('ensureChatsFolder recreates the folder after it is trashed', async () => {
        const mountId = await firstMountId(ctx.bob.user.sessionToken, ctx.bob.user.id);
        const root = await driveGet(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, 'root');
        const before = await driveGetList(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `folder/${root.id}`);

        const seeded = before.find((c) => c.name === 'chats');
        expect(seeded).toBeDefined();
        await driveDelete(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `path/${seeded!.id}`);

        const home = await getHome(ctx.bob.user.id);
        const chatsId = await home.drive.ensureChatsFolder(mountId);
        expect(chatsId).not.toBe(seeded!.id);

        const after = await driveGetList(ctx.bob.user.sessionToken, ctx.bob.user.id, mountId, `folder/${root.id}`);
        const chatsFolders = after.filter((c) => c.name === 'chats');
        expect(chatsFolders).toHaveLength(1);
        expect(chatsFolders[0].id).toBe(chatsId);
        expect(chatsFolders[0].type).toBe('folder');
    });

    test('ensureChatsFolder falls back to the root when chats is a non-folder', async () => {
        const mountId = await firstMountId(ctx.charlie.user.sessionToken, ctx.charlie.user.id);
        const root = await driveGet(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, 'root');
        const before = await driveGetList(
            ctx.charlie.user.sessionToken,
            ctx.charlie.user.id,
            mountId,
            `folder/${root.id}`,
        );

        const seeded = before.find((c) => c.name === 'chats');
        expect(seeded).toBeDefined();
        await driveDelete(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, `path/${seeded!.id}`);

        const file = new File(['not a folder'], 'chats', { type: 'text/plain' });
        await driveUpload(ctx.charlie.user.sessionToken, ctx.charlie.user.id, mountId, root.id, file);

        const home = await getHome(ctx.charlie.user.id);
        const result = await home.drive.ensureChatsFolder(mountId);
        expect(result).toBe(root.id);

        // Nothing renamed or created: still exactly one untrashed `chats`, still the non-folder file.
        const after = await driveGetList(
            ctx.charlie.user.sessionToken,
            ctx.charlie.user.id,
            mountId,
            `folder/${root.id}`,
        );
        const named = after.filter((c) => c.name === 'chats');
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
        const match = matches.find((m) => m.path.id === oneToOneId);
        expect(match).toBeDefined();
        expect(match!.canWrite).toBe(true);
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

describe('Chat wizard — create with members', () => {
    let ctx: TestCtx;
    let mountId: string;
    let rootId: string;
    let chatsFolderId: string;
    let aliceEmail: string;
    let bobEmail: string;

    function createRoom(
        token: string,
        ownerId: string,
        roomMountId: string,
        body: Record<string, unknown>,
    ): Promise<Response> {
        return authedRequest(token, `/chat/${ownerId}/${roomMountId}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function setUserAclEmail(value: boolean): Promise<void> {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notifications: { email: { userOnAclAdd: value } } }),
        });
    }

    async function setGuestAclEmail(value: boolean): Promise<void> {
        await authedRequest(ctx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notifications: { email: { guestOnAclAdd: value } } }),
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceEmail = ctx.alice.user.email;
        bobEmail = ctx.bob.user.email;

        mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        const children = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
        );
        chatsFolderId = children.find((c) => c.name === 'chats' && c.type === 'folder')!.id;
    });

    // userOnAclAdd is shared server state — reset around every test (JsonStore spans the run).
    beforeEach(() => setUserAclEmail(false));
    afterEach(() => setUserAclEmail(false));

    test('creates a chat in the chats folder and shares it with the picked members', async () => {
        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Alice & Bob wizard',
            members: [bobEmail],
        });
        const chat = await assertJson<DrivePath>(res);
        expect(chat.parentId).toBe(chatsFolderId);
        expect(chat.type).toBe('chat');
        expect(chat.acl).toEqual([{ id: bobEmail, read: true, write: true }]);

        // Bob resolves the same chat through his shared-with-me mirror once the fan-out drains.
        const matches = await byMembers(ctx.bob.user.sessionToken, ctx.bob.user.id, aliceEmail);
        const mirrored = matches.find((m) => m.path.id === chat.id);
        expect(mirrored).toBeDefined();
        expect(mirrored!.canWrite).toBe(true);
    });

    test('rejects a document container as the parent, but a plain folder still works', async () => {
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'wizard-parent-guard' },
        );
        const intoContainer = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Sneaky chat',
            members: [bobEmail],
            parentId: doc.id,
        });
        expect(intoContainer.status).toBe(400);

        const intoFolder = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Folder chat',
            members: [bobEmail],
            parentId: chatsFolderId,
        });
        expect(intoFolder.status).toBe(200);
    });

    test('notifies added members in-app but suppresses the share email', async () => {
        // Turn userOnAclAdd on so a plain share WOULD email bob — the wizard must still not.
        await setUserAclEmail(true);
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Suppressed email chat',
            members: [bobEmail],
        });
        const chat = await assertJson<DrivePath>(res);

        const emailed = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === bobEmail));
        expect(emailed.length).toBe(0);
        spy.mockRestore();

        // The in-app notification still lands (authedRequest drains the fan-out before listing).
        const list = await assertJson<Notification[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
        );
        const shared = list.find((n) => n.tag === `share:${ctx.alice.user.id}:${mountId}:${chat.id}`);
        expect(shared?.title).toBe(`${ctx.alice.user.name} shared a chat`);
        expect(shared?.body).toBe('Suppressed email chat');
    });

    test('still emails an unregistered external member while suppressing registered ones', async () => {
        // The share email is the only way an account-less person ever learns about the chat.
        await setUserAclEmail(true);
        await setGuestAclEmail(true);
        const outsiderEmail = `outsider-${randomUUID()}@example.org`;

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Outsider invite chat',
            members: [bobEmail, outsiderEmail],
            dedupeName: true,
        });
        const chat = await assertJson<DrivePath>(res);

        const toOutsider = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === outsiderEmail));
        const toBob = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === bobEmail));
        expect(toOutsider.length).toBe(1);
        expect(toBob.length).toBe(0);
        spy.mockRestore();

        // Bob (registered) still gets the in-app notification; the outsider has no home to notify.
        const list = await assertJson<Notification[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
        );
        const shared = list.find((n) => n.tag === `share:${ctx.alice.user.id}:${mountId}:${chat.id}`);
        expect(shared?.title).toBe(`${ctx.alice.user.name} shared a chat`);
    });

    test('respects an explicit parentId', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            {
                folderName: 'Explicit Parent',
            },
        );
        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            parentId: folder.id,
            fileName: 'Explicit parent chat',
            members: [bobEmail],
        });
        const chat = await assertJson<DrivePath>(res);
        expect(chat.parentId).toBe(folder.id);
    });

    test('returns 409 on a duplicate file name in the target folder', async () => {
        const first = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Duplicate wizard chat',
            members: [bobEmail],
        });
        expect(first.status).toBe(200);

        const second = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Duplicate wizard chat',
            members: [bobEmail],
        });
        expect(second.status).toBe(409);
    });

    test('dedupeName resolves a free name instead of 409ing on a duplicate', async () => {
        const first = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Dedupe wizard chat',
            members: [bobEmail],
            dedupeName: true,
        });
        const firstChat = await assertJson<DrivePath>(first);
        expect(firstChat.name).toBe('Dedupe wizard chat.eigenchat');

        const second = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Dedupe wizard chat',
            members: [bobEmail],
            dedupeName: true,
        });
        const secondChat = await assertJson<DrivePath>(second);
        // getUniqueFileName appends the drive-wide " (2)" suffix in the full-name (.eigenchat) space.
        expect(secondChat.name).toBe('Dedupe wizard chat (2).eigenchat');
    });

    test('rejects guest callers with 403', async () => {
        const email = `wizard-guest-${randomUUID()}@external.com`;
        const password = randomUUID();
        const created = await auth.api.createUser({ body: { email, password, name: 'Wizard Guest', role: 'user' } });
        // Set to 'guest' directly — the admin plugin only allows 'user'/'admin' via the API.
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, created.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        const guestToken =
            (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';

        // Valid body so schema validation passes and the request reaches the requireNonGuest guard.
        const res = await createRoom(guestToken, created.user.id, 'default', {
            fileName: 'Guest chat',
            members: [aliceEmail],
        });
        expect(res.status).toBe(403);
    });

    test('rejects an empty members array with 422', async () => {
        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'No members',
            members: [],
        });
        expect(res.status).toBe(422);
    });

    test('rejects an empty or whitespace-only file name with 422', async () => {
        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: '   ',
            members: [bobEmail],
        });
        expect(res.status).toBe(422);
    });

    test('rejects a non-email member with 422 before creating anything', async () => {
        const before = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${chatsFolderId}`,
        );
        // Owner-shaped ids pass the generic ACL validator — the route must reject them as members.
        const res = await createRoom(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, {
            fileName: 'Owner-shaped member',
            members: [`team_${'a'.repeat(32)}`],
        });
        expect(res.status).toBe(422);

        const after = await driveGetList(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${chatsFolderId}`,
        );
        expect(after.length).toBe(before.length);
    });

    test('by-members rejects a non-email target with 422', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/chat/${ctx.alice.user.id}/rooms/by-members?emails=${encodeURIComponent(`team_${'a'.repeat(32)}`)}`,
        );
        expect(res.status).toBe(422);
    });

    test('a plain PUT acl share still emails when userOnAclAdd is on (suppression is opt-in)', async () => {
        await setUserAclEmail(true);
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        const chatId = await createChat(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            chatsFolderId,
            'Plain share chat',
        );
        await updateAcl(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, chatId, {
            add: [{ id: bobEmail, read: true, write: true }],
        });

        const emailed = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === bobEmail));
        expect(emailed.length).toBe(1);
        spy.mockRestore();
    });
});

describe('Chat wizard — team create', () => {
    let ctx: TestCtx;
    let teamOwner: string;
    let teamMountId: string;
    let teamRootId: string;

    function createRoom(
        token: string,
        ownerId: string,
        mountId: string,
        body: Record<string, unknown>,
    ): Promise<Response> {
        return authedRequest(token, `/chat/${ownerId}/${mountId}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function teamChatsFolderId(): Promise<string | undefined> {
        const children = await driveGetList(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            `folder/${teamRootId}`,
        );
        return children.find((c) => c.name === 'chats' && c.type === 'folder')?.id;
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, 'Team Create Team');
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addTeamMount(ctx, teamId, 'Team Drive');
        teamOwner = teamOwnerId(teamId);
        teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        teamRootId = root.id;
    });

    test('defaults a team chat into a lazily-created chats folder on the team drive', async () => {
        // Teams never seed a chats folder, so the first wizard create must create it.
        expect(await teamChatsFolderId()).toBeUndefined();

        const res = await createRoom(ctx.alice.user.sessionToken, teamOwner, teamMountId, {
            fileName: 'Team default chat',
            members: [],
        });
        const chat = await assertJson<DrivePath>(res);
        expect(chat.type).toBe('chat');

        const chatsId = await teamChatsFolderId();
        expect(chatsId).toBeDefined();
        expect(chat.parentId).toBe(chatsId!);
    });

    test('reuses the same chats folder on a second create', async () => {
        const chatsId = await teamChatsFolderId();
        expect(chatsId).toBeDefined();
        const res = await createRoom(ctx.alice.user.sessionToken, teamOwner, teamMountId, {
            fileName: 'Team second chat',
            members: [],
        });
        const chat = await assertJson<DrivePath>(res);
        expect(chat.parentId).toBe(chatsId!);

        const children = await driveGetList(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            `folder/${teamRootId}`,
        );
        expect(children.filter((c) => c.name === 'chats' && c.type === 'folder')).toHaveLength(1);
    });

    test('respects an explicit parentId in a team folder', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            `folder/${teamRootId}`,
            { folderName: 'Team Explicit' },
        );
        const res = await createRoom(ctx.alice.user.sessionToken, teamOwner, teamMountId, {
            parentId: folder.id,
            fileName: 'Team explicit chat',
            members: [],
        });
        const chat = await assertJson<DrivePath>(res);
        expect(chat.parentId).toBe(folder.id);
    });

    test('lists both root-level and chats-folder team chats (mount-wide)', async () => {
        const rootRes = await createRoom(ctx.alice.user.sessionToken, teamOwner, teamMountId, {
            parentId: teamRootId,
            fileName: 'Team root chat',
            members: [],
        });
        const rootChat = await assertJson<DrivePath>(rootRes);
        expect(rootChat.parentId).toBe(teamRootId);

        const defaultRes = await createRoom(ctx.alice.user.sessionToken, teamOwner, teamMountId, {
            fileName: 'Team listed chat',
            members: [],
        });
        const folderChat = await assertJson<DrivePath>(defaultRes);
        const chatsId = await teamChatsFolderId();
        expect(chatsId).toBeDefined();
        expect(folderChat.parentId).toBe(chatsId!);

        const listed = await driveGetList(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            'mime',
            'application-eigenchat',
        );
        const ids = listed.map((p) => p.id);
        expect(ids).toContain(rootChat.id);
        expect(ids).toContain(folderChat.id);
    });

    test('rejects a non-member with 403', async () => {
        const res = await createRoom(ctx.bob.user.sessionToken, teamOwner, teamMountId, {
            fileName: 'Intruder chat',
            members: [],
        });
        expect(res.status).toBe(403);
    });
});
