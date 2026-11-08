import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import * as decoding from 'lib0/decoding';
import { CollabDocument } from '../../lib/collab/collab-document';
import { getServerConfig } from '../../lib/config/server-config';
import { Drive } from '../../lib/drive';
import { atHome, evictHome, getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    authedRequest,
    createTeam,
    createTestUser,
    driveGet,
    drivePost,
    firstMountId,
    getTestContext,
} from '../setup';

// Read is checked when a collab socket opens, so a membership that goes must close the sockets that lost read with it,
// on every loaded home, whichever way better-auth removed the row. Needs a real listening server.

const USER_IDLE_MS = 5 * 60_000;
const REVOKED = { code: 1008, reason: 'Access revoked' };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let orgId: string;
let port: number | undefined;
const sockets = new Set<WebSocket>();

beforeAll(async () => {
    ctx = await getTestContext();
    const config = getServerConfig();
    if (!config) throw new Error('the server has no org');
    orgId = config.orgId;
    await post('/auth/organization/set-active', { organizationId: orgId });
    port = ctx.app.listen(0).server?.port;
});

afterEach(() => {
    jest.useRealTimers();
    for (const ws of sockets) ws.close();
    sockets.clear();
});

afterAll(() => {
    ctx.app.stop();
});

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

// Resolves once the server's sync step 1 arrived, so the socket is subscribed.
async function openSocket(user: TestUser, ownerId: string, mountId: string, docId: string) {
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${ownerId}/${mountId}/${docId}`,
        { headers: { cookie: `better-auth.session_token=${user.sessionToken}` } },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    let synced = false;
    let frames = 0;
    ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        frames++;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 0) synced = true;
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = ({ code, reason }) => resolve({ code, reason });
    });
    await waitFor(() => synced, 10_000);
    return { ws, closed, frames: () => frames };
}

type Socket = Awaited<ReturnType<typeof openSocket>>;

// An edit reaches every connection the document still has.
async function expectStillReceiving(socket: Socket, ownerId: string, mountId: string, docId: string): Promise<void> {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    const before = socket.frames();
    const document = await (await getHome(ownerId)).drive.getCollabDocument(mountId, docId);
    document.doc.getMap('probe').set('edit', crypto.randomUUID());
    await waitFor(() => socket.frames() > before, 5_000);
}

describe('a membership that goes closes the sockets that lost read', () => {
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
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);

        // Still read through the entry that names them.
        const second = await post('/auth/organization/remove-team-member', { teamId, userId: direct.id });
        expect(second.status).toBe(200);
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
        expect(await removedSocket.closed).toEqual(REVOKED);
        await expectStillReceiving(staysSocket, owner.id, mountId, docId);
    });
});

describe('the walk over the loaded homes', () => {
    test('loads no home that is not loaded', async () => {
        const [removed, unloaded] = await Promise.all([newUser('removed'), newUser('unloaded')]);
        const teamId = await newTeamWith(removed, unloaded);
        await evictHome(unloaded.id);
        expect(atHome(unloaded.id)).toBe(false);

        await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });

        expect(atHome(unloaded.id)).toBe(false);
    });

    test('does not count as a request, so an idle home still closes', async () => {
        const [removed, idle] = await Promise.all([newUser('removed'), newUser('idle')]);
        const teamId = await newTeamWith(removed);
        const home = await getHome(idle.id);

        jest.useFakeTimers();
        home.touch();
        jest.advanceTimersByTime(USER_IDLE_MS - 1_000);
        await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });
        jest.advanceTimersByTime(2_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });

    test('neither waits for a document that is still loading nor starts it', async () => {
        const removed = await newUser('removed');
        const owner = ctx.alice.user;
        const teamId = await newTeamWith(removed);
        const { mountId, docId } = await newDoc(owner);
        const loading = Promise.withResolvers<void>();
        const init = CollabDocument.prototype.init;
        const inits = spyOn(CollabDocument.prototype, 'init').mockImplementationOnce(async function (
            this: CollabDocument,
        ) {
            await loading.promise;
            return init.call(this);
        });
        try {
            const drive = (await getHome(owner.id)).drive;
            const opening = drive.getCollabDocument(mountId, docId);

            const res = await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });

            expect(res.status).toBe(200);
            expect(inits).toHaveBeenCalledTimes(1);
            loading.resolve();
            await opening;
        } finally {
            inits.mockRestore();
        }
    });

    test('a check that fails stops neither the walk nor the removal', async () => {
        const removed = await newUser('removed');
        const teamId = await newTeamWith(removed);
        const owners = [ctx.alice.user, ctx.bob.user];
        const opened = await Promise.all(
            owners.map(async (owner) => {
                const { mountId, docId } = await docSharedWith(owner, teamId);
                return openSocket(removed, owner.id, mountId, docId);
            }),
        );
        const canRead = spyOn(Drive.prototype, 'canRead').mockImplementationOnce(() => {
            throw new Error('a mount that fails');
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await post('/auth/organization/remove-team-member', { teamId, userId: removed.id });

            expect(res.status).toBe(200);
            // The home the walk reaches first keeps its socket, and the other loses it.
            await waitFor(() => opened.some((socket) => socket.ws.readyState === WebSocket.CLOSED), 5_000);
            expect(opened.filter((socket) => socket.ws.readyState === WebSocket.OPEN)).toHaveLength(1);
        } finally {
            canRead.mockRestore();
            errors.mockRestore();
        }
    });
});
