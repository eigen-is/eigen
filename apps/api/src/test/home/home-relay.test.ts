import { afterEach, beforeAll, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACLDelta } from '@workspace/lib/types/drive-access';
import type { Notification } from '@workspace/lib/types/notification';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { getPublicConfig, getServerConfig } from '../../lib/config/server-config';
import { ApiError } from '../../lib/core';
import { Drive } from '../../lib/drive/drive';
import { getSharedDatabase } from '../../lib/drive/shared';
import { sharedPaths } from '../../lib/drive/shared-schema';
import * as getHomeModule from '../../lib/home/get-home';
import {
    drainHomeDeliveries,
    getFromHomes,
    HOME_OPEN_DEADLINE_MS,
    HOME_OPENS_AT_ONCE,
    pushToHomes,
} from '../../lib/home/home-relay';
import * as teamModule from '../../lib/team/team';
import type { User } from '../../lib/user';
import { getMemberships } from '../../lib/user';
import * as userModule from '../../lib/user/user';
import { settlesWithin } from '../../utils/timing';
import type { TestContext, TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    chatPost,
    collectSSE,
    createTeam,
    createTestGuest,
    createTestUser,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// The cap tests need a few more cold homes than the relay opens at once.
const MEMBER_COUNT = HOME_OPENS_AT_ONCE + 3;

let ctx: TestContext;
let teamOwner: string;
let teamMountId: string;
let members: TestUser[];

beforeAll(async () => {
    ctx = await getTestContext();
    const orgId = getServerConfig()!.orgId;
    // The team routes act on the session's active organization.
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
    });
    const teamId = await createTeam(ctx, orgId, 'Relay Team');
    teamOwner = teamOwnerId(teamId);
    await addMember(ctx, teamId, ctx.alice.user.id);
    members = await Promise.all(
        Array.from({ length: MEMBER_COUNT }, async (_, i) => {
            const member = await createTestUser(`relay-member-${i}@test.eigen.is`, 'testpassword123', `Member ${i}`);
            await addMember(ctx, teamId, member.id);
            return member;
        }),
    );
    await addTeamMount(ctx, teamId, 'Relay Drive');
    teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
});

async function notificationsWithTag(member: TestUser, tag: string): Promise<Notification[]> {
    const rows = await assertJson<Notification[]>(
        await authedRequest(member.sessionToken, `/notifications/${member.id}`),
    );
    return rows.filter((row) => row.tag === tag);
}

// Holds the homes of these members at their opening until release(), and counts how many are opening at once.
function holdMemberHomes(held: readonly TestUser[] = members): { peak: () => number; release: () => void } {
    const memberIds = new Set(held.map((member) => member.id));
    const openHome = getHomeModule.getHome;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let opening = 0;
    let peak = 0;
    spyOn(getHomeModule, 'getHome').mockImplementation(async (ownerId) => {
        if (!memberIds.has(ownerId)) return openHome(ownerId);
        opening++;
        peak = Math.max(peak, opening);
        try {
            await released;
            return await openHome(ownerId);
        } finally {
            opening--;
        }
    });
    return { peak: () => peak, release };
}

async function aliceFile(name: string): Promise<DrivePath> {
    const { sessionToken, id } = ctx.alice.user;
    const root = await driveGet<DrivePath>(sessionToken, id, 'default', 'root');
    return driveUpload(sessionToken, id, 'default', root.id, new File(['x'], `${crypto.randomUUID()}-${name}`));
}

async function aliceChangesAccess(path: DrivePath, delta: DriveACLDelta): Promise<void> {
    const alice = await getHomeModule.getHome(ctx.alice.user.id);
    await alice.drive.updateACLDelta('default', path.id, delta, undefined, undefined, alice.user);
}

// Whether the request answers while every delivery is still held.
async function answersFirst(request: Promise<unknown>): Promise<boolean> {
    return Promise.race([request.then(() => true), Bun.sleep(2_000).then(() => false)]);
}

describe('A drive event for the members of a team', () => {
    test('reaches a member whose home is loaded and opens no home that is closed', async () => {
        const [closed, loaded] = members;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const sse = await collectSSE(loaded.id);
        await getHomeModule.evictHome(closed.id);
        try {
            const file = await driveUpload(
                ctx.alice.user.sessionToken,
                teamOwner,
                teamMountId,
                root.id,
                new File(['heard'], 'heard.txt'),
            );
            await sse.next((event) => event.type === SSEventType.DRIVE_FILE_UPLOADED && event.path.id === file.id);
        } finally {
            sse.stop();
        }

        expect(getHomeModule.atHome(closed.id)).toBe(false);
    });
});

describe('A fan-out to many homes', () => {
    afterEach(() => {
        mock.restore();
    });

    test('to the watchers of a file opens one home at a time, after the write answers', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const file = await driveUpload(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            root.id,
            new File(['watched'], 'watched.txt'),
        );
        for (const member of members) {
            const res = await authedRequest(
                member.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/path/${file.id}/watch`,
                { method: 'POST' },
            );
            expect(res.status).toBe(200);
        }

        const held = holdMemberHomes();
        let answered: boolean;
        try {
            const rename = authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${teamOwner}/${teamMountId}/path/${file.id}/rename`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newName: 'renamed.txt' }),
                },
            );
            answered = await answersFirst(rename);
        } finally {
            held.release();
        }
        expect(answered).toBe(true);

        const tag = `file-event:${teamOwner}:${teamMountId}:${file.id}`;
        for (const member of members) {
            await eventually(async () => {
                const rows = await notificationsWithTag(member, tag);
                return rows.length > 0 ? rows : undefined;
            }, `the file event for ${member.email}`);
        }
        expect(held.peak()).toBe(1);
    });

    test('to everyone a chat message mentions runs after the post answers', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const chat = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            `folder/${root.id}/create/chat`,
            { fileName: 'Relay Chat' },
        );

        const held = holdMemberHomes();
        let answered: boolean;
        try {
            const post = chatPost(ctx.alice.user.sessionToken, teamOwner, teamMountId, `${chat.id}/messages`, {
                content: `Hello ${members.map((member) => member.email).join(' ')}`,
            });
            answered = await answersFirst(post);
        } finally {
            held.release();
        }
        expect(answered).toBe(true);

        for (const member of members) {
            await eventually(async () => {
                const rows = await assertJson<Notification[]>(
                    await authedRequest(member.sessionToken, `/notifications/${member.id}`),
                );
                return rows.find((row) => row.type === 'mention-chat' && row.title.includes('Relay Chat'));
            }, `the mention of ${member.email}`);
        }
    });

    test('still reaches the other homes when one delivery fails', async () => {
        const tag = 'relay:one-fails';
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const openHome = getHomeModule.getHome;
        spyOn(getHomeModule, 'getHome').mockImplementation(async (ownerId) => {
            if (ownerId === members[0].id) throw new Error('This home does not open');
            return openHome(ownerId);
        });
        await pushToHomes(
            members.slice(0, 3).map((member) => member.id),
            { type: 'notification', notification: { type: 'admin-alert', title: 'One fails', tag } },
        );
        const logged = errors.mock.calls.map((call) => String(call[0]));
        mock.restore();

        expect(logged.some((line) => line.includes(members[0].id))).toBe(true);
        expect(await notificationsWithTag(members[1], tag)).toHaveLength(1);
        expect(await notificationsWithTag(members[2], tag)).toHaveLength(1);
    });

    // An add and a revoke delivered out of order would bring a removed share back.
    test('of an access change waits for the one before it on that path, while another path goes on', async () => {
        const [file, other] = [await aliceFile('ordered.txt'), await aliceFile('other.txt')];
        const held = holdMemberHomes();
        try {
            await aliceChangesAccess(file, { add: [{ id: members[0].email, read: true, write: false }] });
            await aliceChangesAccess(file, { remove: [members[0].email] });
            await Bun.sleep(50);
            expect(held.peak()).toBe(1);

            await aliceChangesAccess(other, { add: [{ id: members[0].email, read: true, write: false }] });
            await Bun.sleep(50);
            expect(held.peak()).toBe(2);
        } finally {
            held.release();
        }
        await drainHomeDeliveries();
        const shared = await (await getHomeModule.getHome(members[0].id)).drive.getSharedPathsWithMe();
        expect(shared.some((path) => path.id === file.id)).toBe(false);
        expect(shared.some((path) => path.id === other.id)).toBe(true);
    });
});

describe('A read of the paths rows name', () => {
    afterEach(() => {
        mock.restore();
    });

    test('hands each owner only the rows that name its paths', async () => {
        const aliceHome = await getHomeModule.getHome(ctx.alice.user.id);
        const bobHome = await getHomeModule.getHome(ctx.bob.user.id);
        const aliceAsks = spyOn(aliceHome.drive, 'getVisiblePaths');
        const bobAsks = spyOn(bobHome.drive, 'getVisiblePaths');
        const row = (ownerId: string) => ({ ownerId, mountId: 'default', pathId: crypto.randomUUID() });
        const rows = [row(ctx.alice.user.id), row(ctx.bob.user.id), row(ctx.alice.user.id)];
        const viewer = aliceHome.user;

        const memberships = await getMemberships(viewer.id);
        await getFromHomes([ctx.alice.user.id, ctx.bob.user.id], 'drive:visible-paths', {
            user: viewer,
            memberships,
            rows,
            mimeTypePrefix: '',
        });

        expect(aliceAsks.mock.calls.map((call) => call[2])).toEqual([[rows[0], rows[2]]]);
        expect(bobAsks.mock.calls.map((call) => call[2])).toEqual([[rows[1]]]);
    });
});

describe('A search of a team drive', () => {
    test('answers no more paths than the limit it was asked for', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        for (const name of ['relaylimit-a.txt', 'relaylimit-b.txt']) {
            await driveUpload(ctx.alice.user.sessionToken, teamOwner, teamMountId, root.id, new File(['x'], name));
        }

        const all = await getFromHomes([teamOwner], 'drive:search', { q: 'relaylimit', limit: 10 });
        const one = await getFromHomes([teamOwner], 'drive:search', { q: 'relaylimit', limit: 1 });

        expect(all.get(teamOwner)).toHaveLength(2);
        expect(one.get(teamOwner)).toHaveLength(1);
    });
});

describe('A get from many homes', () => {
    let viewer: User;

    beforeAll(async () => {
        viewer = (await getHomeModule.getHome(ctx.alice.user.id)).user;
    });

    afterEach(() => {
        jest.useRealTimers();
        mock.restore();
    });

    function watchesOf(owners: readonly { id: string }[]): Promise<Map<string, DrivePath[]>> {
        return getFromHomes(
            owners.map((owner) => owner.id),
            'drive:watches',
            { user: viewer },
        );
    }

    function sortedIds(owners: readonly { id: string }[]): string[] {
        return owners.map((owner) => owner.id).sort();
    }

    async function closeHomes(owners: readonly TestUser[]): Promise<void> {
        for (const owner of owners) await getHomeModule.evictHome(owner.id);
    }

    // One turn of the event loop. Fake timers leave setImmediate alone, so it also passes while they are on.
    function loopTurn(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    // Moves the fake clock past the deadline until the get has given up on every home it still waits for. The turns
    // before each move let the homes that can answer do so first.
    async function pastDeadline<T>(get: Promise<T>): Promise<T> {
        let settled = false;
        get.finally(() => {
            settled = true;
        });
        while (!settled) {
            for (let turn = 0; turn < 20; turn++) await loopTurn();
            jest.advanceTimersByTime(HOME_OPEN_DEADLINE_MS);
            await loopTurn();
        }
        return get;
    }

    test("answers a user's watches from the owner's drive, without a path whose share was revoked", async () => {
        const { alice, bob } = ctx;
        const mountId = await firstMountId(alice.user.sessionToken, alice.user.id);
        const root = await driveGet<DrivePath>(alice.user.sessionToken, alice.user.id, mountId, 'root');
        const folder = (name: string) =>
            drivePost(alice.user.sessionToken, alice.user.id, mountId, `folder/${root.id}`, { folderName: name });
        const kept = await folder('RelayWatchKept');
        const revoked = await folder('RelayWatchRevoked');
        for (const path of [kept, revoked]) {
            await drivePut(alice.user.sessionToken, alice.user.id, mountId, `path/${path.id}/acl`, {
                add: [{ id: bob.user.email, read: true, write: false }],
            });
            const watched = await authedRequest(
                bob.user.sessionToken,
                `/drive/${alice.user.id}/${mountId}/path/${path.id}/watch`,
                { method: 'POST' },
            );
            expect(watched.status).toBe(200);
        }
        await drivePut(alice.user.sessionToken, alice.user.id, mountId, `path/${revoked.id}/acl`, {
            remove: [bob.user.email],
        });

        const user = (await getHomeModule.getHome(bob.user.id)).user;
        const answers = await getFromHomes([alice.user.id], 'drive:watches', { user });

        expect([...answers.keys()]).toEqual([alice.user.id]);
        expect(answers.get(alice.user.id)?.map((path) => path.id)).toEqual([kept.id]);
    });

    test('leaves out a home that fails, logs it, and the others still answer', async () => {
        const [failing, ...others] = [members[0], members[1], ctx.alice.user];
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        getHomeModule.markHomeRestoring(failing.id);
        let answers: Map<string, DrivePath[]>;
        try {
            answers = await watchesOf([failing, ...others]);
        } finally {
            getHomeModule.clearHomeRestoring(failing.id);
        }

        expect([...answers.keys()].sort()).toEqual(sortedIds(others));
        expect(errors).toHaveBeenCalledWith(`home-relay: drive:watches from ${failing.id} failed:`, expect.anything());
    });

    test('skips an owner who is gone, with no error logged', async () => {
        const gone = { id: crypto.randomUUID().replaceAll('-', '') };
        const errors = spyOn(console, 'error').mockImplementation(() => {});

        const answers = await watchesOf([gone, ctx.alice.user]);

        expect([...answers.keys()]).toEqual([ctx.alice.user.id]);
        expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes(gone.id)))).toBe(false);
    });

    test('skips a team that is gone, with no error logged', async () => {
        const neverMade = teamOwnerId(crypto.randomUUID().replaceAll('-', ''));
        const deletedId = await createTeam(ctx, getServerConfig()!.orgId, 'Deleted Relay Team');
        await getHomeModule.getHome(teamOwnerId(deletedId));
        const removed = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: deletedId }),
        });
        expect(removed.status).toBe(200);
        const gone = [neverMade, teamOwnerId(deletedId)];
        const errors = spyOn(console, 'error').mockImplementation(() => {});

        const answers = await getFromHomes([...gone, teamOwner], 'team:quota-overrides', null);

        expect([...answers.keys()]).toEqual([teamOwner]);
        for (const ownerId of gone) {
            expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes(ownerId)))).toBe(false);
        }
    });

    test('skips an owner whose deletion is running, with no error logged', async () => {
        const [going, live] = [members[0], ctx.alice.user];
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        getHomeModule.markHomeDeleting(going.id);
        let answers: Map<string, DrivePath[]>;
        try {
            answers = await watchesOf([going, live]);
        } finally {
            getHomeModule.clearHomeDeleting(going.id);
        }

        expect([...answers.keys()]).toEqual([live.id]);
        expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes(going.id)))).toBe(false);
    });

    test('answers a loaded home without looking its owner up', async () => {
        const owners = [ctx.alice.user.id, teamOwner];
        for (const ownerId of owners) await getHomeModule.getHome(ownerId);
        const userLookups = spyOn(userModule, 'getUserById');
        const teamLookups = spyOn(teamModule, 'getTeam');

        const answers = await getFromHomes(owners, 'drive:watches', { user: viewer });

        expect([...answers.keys()].sort()).toEqual([...owners].sort());
        expect(userLookups).not.toHaveBeenCalledWith(ctx.alice.user.id);
        expect(teamLookups).not.toHaveBeenCalledWith(parseOwnerId(teamOwner).id);
    });

    test('logs and leaves out a home whose answer is a 404', async () => {
        const [failing, other] = [members[0], ctx.alice.user];
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const failingHome = await getHomeModule.getHome(failing.id);
        spyOn(failingHome.drive, 'getWatches').mockRejectedValue(new ApiError(404, 'Mount not found'));

        const answers = await watchesOf([failing, other]);

        expect([...answers.keys()]).toEqual([other.id]);
        expect(errors).toHaveBeenCalledWith(
            `home-relay: drive:watches from ${failing.id} failed:`,
            expect.objectContaining({ status: 404 }),
        );
    });

    test('logs and leaves out an id that names no owner', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});

        const answers = await watchesOf([{ id: 'not-an-owner' }, ctx.alice.user]);

        expect([...answers.keys()]).toEqual([ctx.alice.user.id]);
        expect(errors).toHaveBeenCalledWith(
            'home-relay: drive:watches from not-an-owner failed:',
            expect.objectContaining({ status: 400 }),
        );
    });

    test('leaves out a home that does not open within the deadline, and the others still answer', async () => {
        const [hung, ...others] = [members[0], members[1], ctx.alice.user];
        for (const owner of others) await getHomeModule.getHome(owner.id);
        const held = holdMemberHomes([hung]);
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        jest.useFakeTimers();
        let answers: Map<string, DrivePath[]>;
        try {
            answers = await pastDeadline(watchesOf([hung, ...others]));
        } finally {
            jest.useRealTimers();
            held.release();
        }

        expect([...answers.keys()].sort()).toEqual(sortedIds(others));
        expect(errors).toHaveBeenCalledWith(
            `home-relay: drive:watches from ${hung.id} failed:`,
            expect.objectContaining({ status: 503 }),
        );
        expect([...(await watchesOf([hung])).keys()]).toEqual([hung.id]);
    });

    test('never opens more homes at once than the cap, also once the deadline has passed', async () => {
        const cold = members.slice(0, HOME_OPENS_AT_ONCE + 3);
        await closeHomes(cold);
        const held = holdMemberHomes(cold);
        spyOn(console, 'error').mockImplementation(() => {});
        jest.useFakeTimers();
        let answers: Map<string, DrivePath[]>;
        try {
            answers = await pastDeadline(watchesOf(cold));
            for (let turn = 0; turn < 20; turn++) await loopTurn();
            expect(held.peak()).toBe(HOME_OPENS_AT_ONCE);
        } finally {
            jest.useRealTimers();
            held.release();
        }
        expect(answers.size).toBe(0);

        expect([...(await watchesOf(cold)).keys()].sort()).toEqual(sortedIds(cold));
        expect(held.peak()).toBe(HOME_OPENS_AT_ONCE);
    });

    test('many callers of one home that hangs leave the other slots free', async () => {
        const [hung, healthy] = members;
        await closeHomes([hung, healthy]);
        const held = holdMemberHomes([hung]);
        const waiting = Array.from({ length: HOME_OPENS_AT_ONCE }, () => watchesOf([hung]));
        let answers: Map<string, DrivePath[]>;
        try {
            await eventually(async () => held.peak() > 0 || undefined, 'the open of the hung home');
            await Bun.sleep(50);
            answers = await watchesOf([healthy]);
        } finally {
            held.release();
        }

        expect([...answers.keys()]).toEqual([healthy.id]);
        for (const answer of await Promise.all(waiting)) expect([...answer.keys()]).toEqual([hung.id]);
    });

    test('a loaded home answers while every slot is taken', async () => {
        const cold = members.slice(0, HOME_OPENS_AT_ONCE);
        await closeHomes(cold);
        const held = holdMemberHomes(cold);
        const waiting = watchesOf(cold);
        let answers: Map<string, DrivePath[]>;
        try {
            await eventually(async () => held.peak() === HOME_OPENS_AT_ONCE || undefined, 'every slot taken');
            answers = await watchesOf([ctx.alice.user]);
        } finally {
            held.release();
        }

        expect([...answers.keys()]).toEqual([ctx.alice.user.id]);
        expect([...(await waiting).keys()].sort()).toEqual(sortedIds(cold));
    });
});

describe('An answer that is slow to come', () => {
    afterEach(() => {
        mock.restore();
    });

    test('holds no slot, so a closed home still opens and answers', async () => {
        const slow = members.slice(0, HOME_OPENS_AT_ONCE);
        const closed = members[HOME_OPENS_AT_ONCE];
        for (const owner of [...slow, closed]) await getHomeModule.evictHome(owner.id);
        const slowAsker = (await getHomeModule.getHome(ctx.bob.user.id)).user;
        const quickAsker = (await getHomeModule.getHome(ctx.alice.user.id)).user;
        const getWatches = Drive.prototype.getWatches;
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const asked = spyOn(Drive.prototype, 'getWatches').mockImplementation(async function (this: Drive, user) {
            if (user.id === slowAsker.id) await released;
            return getWatches.call(this, user);
        });
        const waiting = getFromHomes(
            slow.map((owner) => owner.id),
            'drive:watches',
            { user: slowAsker },
        );
        let answers: Map<string, DrivePath[]>;
        try {
            await eventually(
                async () => asked.mock.calls.length === HOME_OPENS_AT_ONCE || undefined,
                'every slow answer running',
            );
            answers = await getFromHomes([closed.id], 'drive:watches', { user: quickAsker });
        } finally {
            release();
        }

        expect([...answers.keys()]).toEqual([closed.id]);
        expect((await waiting).size).toBe(HOME_OPENS_AT_ONCE);
    });
});

describe('An answer that asks the relay again', () => {
    // A team Home never receives a shared row: one is put in each by hand, so each answer opens the sharer's closed
    // home, a nested get. With more teams than slots, every answer needs one more open while every slot is busy.
    test('finishes while every slot is busy', async () => {
        const sharer = await createTestUser(
            `relay-sharer-${crypto.randomUUID()}@test.eigen.is`,
            'testpassword123',
            'Sharer',
        );
        const root = await driveGet<DrivePath>(sharer.sessionToken, sharer.id, 'default', 'root');
        const file = await driveUpload(
            sharer.sessionToken,
            sharer.id,
            'default',
            root.id,
            new File(['x'], 'nested.txt', { type: 'text/plain' }),
        );
        await drivePut(sharer.sessionToken, sharer.id, 'default', `path/${file.id}/acl`, { visibility: 'public-read' });
        const teams: string[] = [];
        for (let i = 0; i <= HOME_OPENS_AT_ONCE; i++) {
            const team = teamOwnerId(await createTeam(ctx, getPublicConfig().orgId, `Nested ${crypto.randomUUID()}`));
            const sharedDb = await getSharedDatabase(await getHomeModule.getHome(team));
            sharedDb
                .insert(sharedPaths)
                .values({ ownerId: sharer.id, mountId: 'default', pathId: file.id, sharedAt: new Date() })
                .run();
            teams.push(team);
        }
        for (const ownerId of [sharer.id, ...teams]) await getHomeModule.evictHome(ownerId);

        const answers = await getFromHomes(teams, 'drive:mime-contents', { mimeType: 'text/plain' });

        for (const team of teams) expect(answers.get(team)?.map((path) => path.id)).toEqual([file.id]);
    });
});

describe('A question about the calendars of a home', () => {
    test('is answered with null by a team whose calendar is off and by a guest, and with a list by a user', async () => {
        const guest = await createTestGuest('Relay Guest');
        const owners = [teamOwner, guest.id, ctx.alice.user.id];

        const answers = await getFromHomes(owners, 'calendar:calendars', null);

        expect([...answers.keys()].sort()).toEqual([...owners].sort());
        expect(answers.get(teamOwner)).toBeNull();
        expect(answers.get(guest.id)).toBeNull();
        expect(answers.get(ctx.alice.user.id)?.some((calendar) => calendar.isDefault)).toBe(true);
    });
});

describe('A graceful shutdown', () => {
    afterEach(() => {
        mock.restore();
    });

    test('waits for a push to one home still delivering', async () => {
        const tag = 'relay-drain:direct';
        const held = holdMemberHomes();
        let drainedFirst: boolean;
        try {
            pushToHomes([members[0].id], {
                type: 'notification',
                notification: { type: 'admin-alert', title: 'Direct', tag },
            });
            drainedFirst = await answersFirst(drainHomeDeliveries());
        } finally {
            held.release();
        }
        expect(drainedFirst).toBe(false);

        await drainHomeDeliveries();
        expect(await notificationsWithTag(members[0], tag)).toHaveLength(1);
    });

    // A delivery reopens the recipient's home, so the shutdown waits for it before it closes the homes.
    test('waits for the deliveries a fan-out started after its request answered', async () => {
        const tag = 'relay-drain:detached';
        const held = holdMemberHomes();
        let drainedFirst: boolean;
        try {
            pushToHomes(
                members.map((member) => member.id),
                { type: 'notification', notification: { type: 'admin-alert', title: 'Detached', tag } },
            );
            drainedFirst = await answersFirst(drainHomeDeliveries());
        } finally {
            held.release();
        }
        expect(drainedFirst).toBe(false);

        await drainHomeDeliveries();
        for (const member of members) {
            expect(await notificationsWithTag(member, tag)).toHaveLength(1);
        }
    });

    // The second change has not reached the relay yet: it starts when the first has been delivered.
    test('waits until a second access change to a path, queued behind the first, is delivered', async () => {
        const file = await aliceFile('drained.txt');
        const receive = spyOn((await getHomeModule.getHome(members[0].id)).drive, 'receiveSharedPathChange');
        const held = holdMemberHomes();
        try {
            await aliceChangesAccess(file, { add: [{ id: members[0].email, read: true, write: false }] });
            await aliceChangesAccess(file, { remove: [members[0].email] });
            const drained = drainHomeDeliveries();
            held.release();
            await drained;
        } finally {
            held.release();
        }
        expect(receive.mock.calls.map(([, acl]) => acl?.length ?? 0)).toEqual([1, 0]);
    });

    // The shutdown wraps its wait in settlesWithin with a bound of its own, which no test drives. This pins the
    // wrap, on a delivery stuck on a home that never opens.
    test('a bounded wait gives up on a delivery that never settles, and the delivery still lands', async () => {
        const tag = 'relay-drain:stalled';
        const held = holdMemberHomes();
        let drainedFirst: boolean;
        let settled: boolean;
        try {
            pushToHomes([members[0].id], {
                type: 'notification',
                notification: { type: 'admin-alert', title: 'Stalled', tag },
            });
            const bounded = settlesWithin(drainHomeDeliveries(), 100);
            drainedFirst = await answersFirst(bounded);
            settled = await bounded;
        } finally {
            held.release();
        }
        expect(drainedFirst).toBe(true);
        expect(settled).toBe(false);

        await drainHomeDeliveries();
        expect(await notificationsWithTag(members[0], tag)).toHaveLength(1);
    });
});
