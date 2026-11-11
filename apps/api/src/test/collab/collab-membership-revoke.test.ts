import type { Mock } from 'bun:test';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON } from '@workspace/lib/constants/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { eq } from 'drizzle-orm';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { session as sessionTable, user as userTable } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { CollabDocument } from '../../lib/collab/collab-document';
import { getServerConfig } from '../../lib/config/server-config';
import { Drive } from '../../lib/drive';
import { getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    createTestGuest,
    createTestUser,
    driveGet,
    drivePost,
    extractSessionToken,
    firstMountId,
    getTestContext,
} from '../setup';

// Read is checked when a collab socket opens and again on its 15 s keepalive, along with its session. So a socket that
// lost read or whose session ended closes at the next tick, whichever way the row went. Needs a real listening server.
// The tests run a tick by hand: the callback each socket gave setInterval, the real one, with no wait.

// The y-websocket message type of a sync frame.
const MESSAGE_SYNC = 0;

const REVOKED = { code: COLLAB_ACCESS_LOST_CLOSE, reason: COLLAB_ACCESS_LOST_REASON };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let orgId: string;
let port: number | undefined;
const sockets = new Set<WebSocket>();
let intervals: Mock<typeof setInterval>;

beforeAll(async () => {
    intervals = spyOn(globalThis, 'setInterval');
    ctx = await getTestContext();
    const config = getServerConfig();
    if (!config) throw new Error('the server has no org');
    orgId = config.orgId;
    await post('/auth/organization/set-active', { organizationId: orgId });
    port = ctx.app.listen(0).server?.port;
});

afterEach(() => {
    for (const ws of sockets) ws.close();
    sockets.clear();
    intervals.mockClear();
});

afterAll(() => {
    ctx.app.stop();
    intervals.mockRestore();
});

// Runs every keepalive once and waits for its checks.
async function tick(): Promise<void> {
    await Promise.all(intervals.mock.calls.filter(([, ms]) => ms === 15_000).map(([keepalive]) => keepalive()));
}

// As alice, who owns the org.
function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function newUser(name: string): Promise<TestUser> {
    return createTestUser(`${name}-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', name);
}

async function newTeamWith(...users: TestUser[]): Promise<string> {
    const teamId = await createTeam(ctx, orgId, `Revoke ${crypto.randomUUID()}`);
    for (const user of users) await addMember(ctx, teamId, user.id);
    return teamId;
}

async function newDoc(owner: TestUser): Promise<{ mountId: string; docId: string }> {
    const mountId = await firstMountId(owner.sessionToken, owner.id);
    const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
    const doc = await drivePost<DrivePath>(owner.sessionToken, owner.id, mountId, `folder/${root.id}/create/doc`, {
        fileName: `Revoke probe ${crypto.randomUUID()}`,
    });
    return { mountId, docId: doc.id };
}

// A doc in the owner's Home, shared with the team and with whoever else is named.
async function docSharedWith(owner: TestUser, teamId: string, ...direct: TestUser[]) {
    const { mountId, docId } = await newDoc(owner);
    const acl = [teamOwnerId(teamId), ...direct.map((user) => user.email)].map((id) => ({
        id,
        read: true,
        write: false,
    }));
    await (await getHome(owner.id)).drive.updateACL(mountId, docId, acl);
    return { mountId, docId };
}

// A doc in the owner's Home that names each user in its ACL, with write.
async function docNaming(owner: TestUser, ...direct: TestUser[]) {
    const { mountId, docId } = await newDoc(owner);
    const acl = direct.map((user) => ({ id: user.email, read: true, write: true }));
    await (await getHome(owner.id)).drive.updateACL(mountId, docId, acl);
    return { mountId, docId };
}

function connect(user: TestUser, ownerId: string, mountId: string, docId: string) {
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${ownerId}/${mountId}/${docId}`,
        { headers: { cookie: `better-auth.session_token=${user.sessionToken}` } },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    let frames = 0;
    // The kind of each sync frame: only a step 2 or an update carries document content.
    const syncFrames: number[] = [];
    ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        frames++;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) === MESSAGE_SYNC) syncFrames.push(decoding.readVarUint(decoder));
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = ({ code, reason }) => resolve({ code, reason });
    });
    return { ws, closed, syncFrames, frames: () => frames };
}

type Socket = ReturnType<typeof connect>;
type Doc = Awaited<ReturnType<typeof newDoc>>;

// Resolves once the server's sync step 1 arrived, so the socket is subscribed.
async function openSocket(user: TestUser, ownerId: string, mountId: string, docId: string): Promise<Socket> {
    const socket = connect(user, ownerId, mountId, docId);
    await waitFor(() => socket.syncFrames.includes(syncProtocol.messageYjsSyncStep1), 10_000);
    return socket;
}

// An edit reaches every connection the document still has.
async function expectStillReceiving(socket: Socket, ownerId: string, mountId: string, docId: string): Promise<void> {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    const before = socket.frames();
    const document = await (await getHome(ownerId)).drive.getCollabDocument(mountId, docId);
    document.doc.getMap('probe').set('edit', crypto.randomUUID());
    await waitFor(() => socket.frames() > before, 5_000);
}

describe('a membership that goes closes the sockets that lost read at the next tick', () => {
    test("removal from a team, on a doc shared with the team in another owner's Home", async () => {
        const [removed, stays, direct] = await Promise.all([newUser('removed'), newUser('stays'), newUser('direct')]);
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(removed, stays, direct);
        const { mountId, docId } = await docSharedWith(owner, teamId, direct);
        const removedSocket = await openSocket(removed, owner.id, mountId, docId);
        const staysSocket = await openSocket(stays, owner.id, mountId, docId);
        const directSocket = await openSocket(direct, owner.id, mountId, docId);

        const first = await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });
        expect(first.status).toBe(200);
        await tick();
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);

        // Still read through the entry that names them.
        const second = await post('/auth/organization/remove-team-member', { teamId, userId: direct.id });
        expect(second.status).toBe(200);
        await tick();
        await expectStillReceiving(directSocket, owner.id, mountId, docId);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);
    });

    test("removal from a team, on a doc in the team's own drive", async () => {
        const [removed, stays] = await Promise.all([newUser('removed'), newUser('stays')]);
        const teamId = await newTeamWith(ctx.alice.user, removed, stays);
        await addTeamMount(ctx, teamId, 'Revoke drive');
        const ownerId = teamOwnerId(teamId);
        const token = ctx.alice.user.sessionToken;
        const mountId = await firstMountId(token, ownerId);
        const root = await driveGet<DrivePath>(token, ownerId, mountId, 'root');
        const doc = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${root.id}/create/doc`, {
            fileName: 'Team drive probe',
        });
        const removedSocket = await openSocket(removed, ownerId, mountId, doc.id);
        const staysSocket = await openSocket(stays, ownerId, mountId, doc.id);

        await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });
        await tick();

        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, ownerId, mountId, doc.id);
    });

    test('removal from the org', async () => {
        const [removed, stays] = await Promise.all([newUser('removed'), newUser('stays')]);
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(removed, stays);
        const { mountId, docId } = await docSharedWith(owner, teamId);
        const removedSocket = await openSocket(removed, owner.id, mountId, docId);
        const staysSocket = await openSocket(stays, owner.id, mountId, docId);

        const res = await post('/auth/organization/remove-member', {
            memberIdOrEmail: removed.email,
            organizationId: orgId,
        });

        expect(res.status).toBe(200);
        await tick();
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);
    });

    test('deletion of the team', async () => {
        const [member, direct] = await Promise.all([newUser('member'), newUser('direct')]);
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(member);
        const { mountId, docId } = await docSharedWith(owner, teamId, direct);
        const memberSocket = await openSocket(member, owner.id, mountId, docId);
        const directSocket = await openSocket(direct, owner.id, mountId, docId);

        const res = await post('/auth/organization/remove-team', { teamId, organizationId: orgId });

        expect(res.status).toBe(200);
        await tick();
        expect(await memberSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(directSocket, owner.id, mountId, docId);
    });

    test('deletion of the user', async () => {
        const [removed, stays] = await Promise.all([newUser('removed'), newUser('stays')]);
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(removed, stays);
        const { mountId, docId } = await docSharedWith(owner, teamId);
        const removedSocket = await openSocket(removed, owner.id, mountId, docId);
        const staysSocket = await openSocket(stays, owner.id, mountId, docId);

        const res = await post('/auth/admin/remove-user', { userId: removed.id });

        expect(res.status).toBe(200);
        await tick();
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);
    });

    test('deletion of a user the ACL names, whose entry stays', async () => {
        const [removed, sibling] = await Promise.all([newUser('removed'), newUser('sibling')]);
        const owner = ctx.alice.user;
        const { mountId, docId } = await docNaming(owner, removed, sibling);
        const removedSocket = await openSocket(removed, owner.id, mountId, docId);
        const siblingSocket = await openSocket(sibling, owner.id, mountId, docId);

        const res = await post('/auth/admin/remove-user', { userId: removed.id });

        expect(res.status).toBe(200);
        await tick();
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(siblingSocket, owner.id, mountId, docId);
    });

    test('deletion of a guest the ACL names, and the guest beside them stays', async () => {
        const [removed, stays] = await Promise.all([createTestGuest('Removed'), createTestGuest('Stays')]);
        const owner = ctx.alice.user;
        const { mountId, docId } = await docNaming(owner, removed, stays);
        const removedSocket = await openSocket(removed, owner.id, mountId, docId);
        const staysSocket = await openSocket(stays, owner.id, mountId, docId);

        const res = await post('/auth/admin/remove-user', { userId: removed.id });

        expect(res.status).toBe(200);
        await tick();
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);
    });

    test("removal from a team whose grant sits on the doc's folder, and the owner's own socket stays", async () => {
        const removed = await newUser('removed');
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(removed);
        const mountId = await firstMountId(owner.sessionToken, owner.id);
        const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
        const home = await getHome(owner.id);
        const drive = home.drive;
        const folder = await drive.createFolder(mountId, root.id, `Revoke folder ${crypto.randomUUID()}`, home.user);
        await drive.updateACL(mountId, folder.id, [{ id: teamOwnerId(teamId), read: true, write: false }]);
        const doc = await drivePost<DrivePath>(
            owner.sessionToken,
            owner.id,
            mountId,
            `folder/${folder.id}/create/doc`,
            {
                fileName: 'Inherited probe',
            },
        );
        const removedSocket = await openSocket(removed, owner.id, mountId, doc.id);
        const ownerSocket = await openSocket(owner, owner.id, mountId, doc.id);

        await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });
        await tick();

        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(ownerSocket, owner.id, mountId, doc.id);
    });
});

describe('a session that ends closes the sockets it opened at the next tick', () => {
    // Two sessions of one user, as on a laptop and a phone, each with a socket on a doc the user may read.
    async function twoSessionsOnOwnDoc() {
        const email = `sessions-${crypto.randomUUID()}@test.eigen.is`;
        const first = await createTestUser(email, 'testpassword123', 'Sessions');
        const second = await createTestUser(email, 'testpassword123', 'Sessions');
        const doc = await newDoc(first);
        const firstSocket = await openSocket(first, first.id, doc.mountId, doc.docId);
        const secondSocket = await openSocket(second, first.id, doc.mountId, doc.docId);
        return { first, second, doc, firstSocket, secondSocket };
    }

    function asUser(token: string, path: string, body: Record<string, unknown> = {}): Promise<Response> {
        return authedRequest(token, path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test("an admin's password reset closes them whether or not the user may still read, and no one else's", async () => {
        const [locked, stays] = await Promise.all([newUser('locked'), newUser('stays')]);
        const owner = ctx.alice.user;
        const shared = await docNaming(owner, locked, stays);
        const own = await newDoc(locked);
        const sharedSocket = await openSocket(locked, owner.id, shared.mountId, shared.docId);
        const ownSocket = await openSocket(locked, locked.id, own.mountId, own.docId);
        const staysSocket = await openSocket(stays, owner.id, shared.mountId, shared.docId);

        const res = await authedRequest(owner.sessionToken, `/settings/user/${locked.id}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'a-new-password-1' }),
        });
        await tick();

        expect(res.status).toBe(200);
        expect(await sharedSocket.closed).toEqual(REVOKED);
        expect(await ownSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, shared.mountId, shared.docId);
    });

    test('a password change that revokes the other sessions closes all of them, and the new session opens', async () => {
        const { first, doc, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();

        const res = await asUser(first.sessionToken, '/auth/change-password', {
            currentPassword: 'testpassword123',
            newPassword: 'a-new-password-1',
            revokeOtherSessions: true,
        });
        expect(res.status).toBe(200);
        await tick();

        expect(await firstSocket.closed).toEqual(REVOKED);
        expect(await secondSocket.closed).toEqual(REVOKED);

        // The reload of the tab that changed it carries the new cookie, and that socket stays through a tick.
        const reloaded = { ...first, sessionToken: extractSessionToken(res.headers) };
        const socket = await openSocket(reloaded, first.id, doc.mountId, doc.docId);
        await tick();
        await expectStillReceiving(socket, first.id, doc.mountId, doc.docId);
    });

    test('a password change that keeps the sessions closes nothing', async () => {
        const { first, doc, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();

        const res = await asUser(first.sessionToken, '/auth/change-password', {
            currentPassword: 'testpassword123',
            newPassword: 'a-new-password-1',
        });
        expect(res.status).toBe(200);
        await tick();

        await expectStillReceiving(firstSocket, first.id, doc.mountId, doc.docId);
        await expectStillReceiving(secondSocket, first.id, doc.mountId, doc.docId);
    });

    test('/auth/revoke-sessions closes every session, its own included', async () => {
        const { first, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();

        expect((await asUser(first.sessionToken, '/auth/revoke-sessions')).status).toBe(200);
        await tick();

        expect(await firstSocket.closed).toEqual(REVOKED);
        expect(await secondSocket.closed).toEqual(REVOKED);
    });

    test('/auth/revoke-other-sessions closes the others and keeps its own', async () => {
        const { first, doc, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();

        expect((await asUser(first.sessionToken, '/auth/revoke-other-sessions')).status).toBe(200);
        await tick();

        expect(await secondSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(firstSocket, first.id, doc.mountId, doc.docId);
    });

    test('a sign-out closes that session and keeps the other', async () => {
        const { first, doc, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();

        expect((await asUser(first.sessionToken, '/auth/sign-out')).status).toBe(200);
        await tick();

        expect(await firstSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(secondSocket, first.id, doc.mountId, doc.docId);
    });

    test('a session past its expiry closes though its row is still there', async () => {
        const { first, doc, firstSocket, secondSocket } = await twoSessionsOnOwnDoc();
        const token = decodeURIComponent(first.sessionToken).split('.')[0] ?? '';

        await getAuthDrizzleDb()
            .update(sessionTable)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(sessionTable.token, token));
        await tick();

        expect(await firstSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(secondSocket, first.id, doc.mountId, doc.docId);
    });
});

describe('a share that goes', () => {
    // A frame that sets one key, as an editor would.
    function editFrame(key: string): Uint8Array {
        const edit = new Y.Doc();
        edit.getMap('probe').set(key, 'typed');
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(edit));
        return encoding.toUint8Array(encoder);
    }

    test('refuses the next edit at once, and closes the socket at the next tick', async () => {
        const sharee = await newUser('sharee');
        const owner = ctx.alice.user;
        const { mountId, docId } = await docNaming(owner, sharee);
        const shareeSocket = await openSocket(sharee, owner.id, mountId, docId);
        const ownerSocket = await openSocket(owner, owner.id, mountId, docId);
        const drive = (await getHome(owner.id)).drive;
        const document = await drive.getCollabDocument(mountId, docId);
        const probe = document.doc.getMap('probe');

        shareeSocket.ws.send(new Uint8Array(editFrame('while shared')));
        await waitFor(() => probe.has('while shared'), 5_000);

        await drive.updateACL(mountId, docId, []);

        expect(shareeSocket.ws.readyState).toBe(WebSocket.OPEN);
        shareeSocket.ws.send(new Uint8Array(editFrame('after the share went')));
        await Bun.sleep(100);
        expect(probe.has('after the share went')).toBe(false);

        await tick();
        expect(await shareeSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(ownerSocket, owner.id, mountId, docId);
    });

    test('the tick leaves the readers of another document, and a writer who keeps read', async () => {
        const [revoked, demoted] = await Promise.all([newUser('revoked'), newUser('demoted')]);
        const owner = ctx.alice.user;
        const untouched = await docNaming(owner, revoked);
        const changed = await docNaming(owner, revoked, demoted);
        const drive = (await getHome(owner.id)).drive;
        const untouchedSocket = await openSocket(revoked, owner.id, untouched.mountId, untouched.docId);
        const revokedSocket = await openSocket(revoked, owner.id, changed.mountId, changed.docId);
        const demotedSocket = await openSocket(demoted, owner.id, changed.mountId, changed.docId);

        await drive.updateACL(changed.mountId, changed.docId, [{ id: demoted.email, read: true, write: false }]);
        await tick();

        expect(await revokedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(untouchedSocket, owner.id, untouched.mountId, untouched.docId);
        await expectStillReceiving(demotedSocket, owner.id, changed.mountId, changed.docId);
    });

    test('a move out of a shared folder closes who read through it, and a move within it closes no one', async () => {
        const sharee = await newUser('sharee');
        const owner = ctx.alice.user;
        const mountId = await firstMountId(owner.sessionToken, owner.id);
        const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
        const home = await getHome(owner.id);
        const drive = home.drive;
        const folder = await drive.createFolder(mountId, root.id, `Shared ${crypto.randomUUID()}`, home.user);
        await drive.updateACL(mountId, folder.id, [{ id: sharee.email, read: true, write: true }]);
        const inner = await drive.createFolder(mountId, folder.id, 'Inner', home.user);
        const doc = await drivePost<DrivePath>(
            owner.sessionToken,
            owner.id,
            mountId,
            `folder/${folder.id}/create/doc`,
            {
                fileName: 'Moving probe',
            },
        );
        const shareeSocket = await openSocket(sharee, owner.id, mountId, doc.id);
        const ownerSocket = await openSocket(owner, owner.id, mountId, doc.id);

        await drive.movePath(mountId, doc.id, inner.id, home.user);
        await tick();
        await expectStillReceiving(shareeSocket, owner.id, mountId, doc.id);

        await drive.movePath(mountId, doc.id, root.id, home.user);
        expect(shareeSocket.ws.readyState).toBe(WebSocket.OPEN);
        await tick();

        expect(await shareeSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(ownerSocket, owner.id, mountId, doc.id);
    });

    test('a new email closes the socket that the old address in the ACL let in', async () => {
        const sharee = await newUser('sharee');
        const owner = ctx.alice.user;
        const { mountId, docId } = await docNaming(owner, sharee);
        const socket = await openSocket(sharee, owner.id, mountId, docId);

        await getAuthDrizzleDb()
            .update(userTable)
            .set({ email: `moved-${crypto.randomUUID()}@test.eigen.is` })
            .where(eq(userTable.id, sharee.id));
        await tick();

        expect(await socket.closed).toEqual(REVOKED);
    });
});

describe('an open that is still loading the document', () => {
    // A removal or an ACL change finds no connection on a document that still loads. The socket sends its frame, which
    // waits for the open, then `revoke` runs, then the load ends.
    async function revokeDuringLoad(
        user: TestUser,
        { mountId, docId }: Doc,
        frame: Uint8Array,
        revoke: () => Promise<unknown>,
    ): Promise<Socket> {
        const owner = ctx.alice.user;
        const loading = Promise.withResolvers<void>();
        const open = CollabDocument.open;
        const inits = spyOn(CollabDocument, 'open').mockImplementationOnce(async (drive, path) => {
            await loading.promise;
            return open(drive, path);
        });
        try {
            const socket = connect(user, owner.id, mountId, docId);
            await new Promise((resolve) => {
                socket.ws.onopen = resolve;
            });
            await waitFor(() => inits.mock.calls.length === 1, 10_000);
            socket.ws.send(new Uint8Array(frame));
            await revoke();
            loading.resolve();
            expect(await socket.closed).toEqual(REVOKED);
            return socket;
        } finally {
            inits.mockRestore();
        }
    }

    // A client's own step 1, which asks for the whole document in reply.
    function syncStep1Frame(): Uint8Array {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, new Y.Doc());
        return encoding.toUint8Array(encoder);
    }

    function contentFrames(socket: Socket): number[] {
        return socket.syncFrames.filter((kind) => kind !== syncProtocol.messageYjsSyncStep1);
    }

    test('a removal from the team closes it with no content', async () => {
        const removed = await newUser('removed');
        const teamId = await newTeamWith(removed);
        const doc = await docSharedWith(ctx.alice.user, teamId);

        const socket = await revokeDuringLoad(removed, doc, syncStep1Frame(), async () => {
            const res = await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });
            expect(res.status).toBe(200);
        });

        expect(contentFrames(socket)).toEqual([]);
    });

    test('an ACL change closes it with no content', async () => {
        const removed = await newUser('removed');
        const doc = await docNaming(ctx.alice.user, removed);
        const drive = (await getHome(ctx.alice.user.id)).drive;

        const socket = await revokeDuringLoad(removed, doc, syncStep1Frame(), () =>
            drive.updateACL(doc.mountId, doc.docId, []),
        );

        expect(contentFrames(socket)).toEqual([]);
    });

    test("a deleted writer's edit that waited for the open changes nothing", async () => {
        const removed = await newUser('removed');
        const owner = ctx.alice.user;
        const doc = await docNaming(owner, removed);
        const edit = new Y.Doc();
        edit.getMap('probe').set('edit', 'from the deleted user');
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(edit));

        await revokeDuringLoad(removed, doc, encoding.toUint8Array(encoder), async () => {
            const res = await post('/auth/admin/remove-user', { userId: removed.id });
            expect(res.status).toBe(200);
        });

        const document = await (await getHome(owner.id)).drive.getCollabDocument(doc.mountId, doc.docId);
        await Bun.sleep(100);
        expect(document.doc.getMap('probe').size).toBe(0);
    });
});

describe('the tick', () => {
    test('counts as no request on the home of an open socket', async () => {
        const idle = await newUser('idle');
        const { mountId, docId } = await newDoc(idle);
        const socket = await openSocket(idle, idle.id, mountId, docId);
        const home = await getHome(idle.id);
        const canRead = spyOn(home.drive, 'canRead');
        const requests = spyOn(home, 'touch');
        try {
            await tick();

            expect(canRead).toHaveBeenCalled();
            expect(requests).not.toHaveBeenCalled();
            expect(socket.ws.readyState).toBe(WebSocket.OPEN);
        } finally {
            canRead.mockRestore();
            requests.mockRestore();
        }
    });

    test('a check that fails keeps the socket, and the next tick asks again', async () => {
        const sharee = await newUser('sharee');
        const owner = ctx.alice.user;
        const { mountId, docId } = await docNaming(owner, sharee);
        const socket = await openSocket(sharee, owner.id, mountId, docId);
        await (await getHome(owner.id)).drive.updateACL(mountId, docId, []);
        const canRead = spyOn(Drive.prototype, 'canRead').mockImplementationOnce(() => {
            throw new Error('a mount that fails');
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await tick();
            expect(socket.ws.readyState).toBe(WebSocket.OPEN);
            expect(errors).toHaveBeenCalled();

            await tick();
            expect(await socket.closed).toEqual(REVOKED);
        } finally {
            canRead.mockRestore();
            errors.mockRestore();
        }
    });
});
