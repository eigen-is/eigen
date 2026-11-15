import { afterEach, beforeAll, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { getServerConfig } from '../../lib/config/server-config';
import { Drive } from '../../lib/drive/drive';
import * as getHomeModule from '../../lib/home/get-home';
import {
    drainDeliveriesWithin,
    drainHomeDeliveries,
    getFromHomes,
    HOME_OPEN_DEADLINE_MS,
    HOME_OPENS_AT_ONCE,
    pullVisiblePaths,
    sendToHome,
    sendToUserHomes,
} from '../../lib/home/home-relay';
import type { User } from '../../lib/user';
import { getMemberships } from '../../lib/user';
import type { TestContext, TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    chatPost,
    createTeam,
    createTestUser,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

const MEMBER_COUNT = 20;

let ctx: TestContext;
let teamOwner: string;
let teamMountId: string;
const members: TestUser[] = [];

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
    for (let i = 0; i < MEMBER_COUNT; i++) {
        const member = await createTestUser(`relay-member-${i}@test.eigen.is`, 'testpassword123', `Member ${i}`);
        await addMember(ctx, teamId, member.id);
        members.push(member);
    }
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

// Whether the request answers while every delivery is still held.
async function answersFirst(request: Promise<unknown>): Promise<boolean> {
    return Promise.race([request.then(() => true), Bun.sleep(2_000).then(() => false)]);
}

describe('A notification to a team', () => {
    test('reaches every member of the team', async () => {
        const tag = 'relay:team-notification';
        await sendToHome(teamOwner, {
            type: 'notification',
            notification: { type: 'admin-alert', title: 'To the whole team', tag },
        });

        for (const member of members) {
            expect(await notificationsWithTag(member, tag)).toHaveLength(1);
        }
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
        await sendToUserHomes(
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
    test('of a path waits for the one before it, while another path goes on', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const change = (path: DrivePath, acl: DrivePath['acl']) => ({ type: 'drive:acl-change' as const, path, acl });
        const recipient = [members[0].id];
        const held = holdMemberHomes();
        try {
            const add = sendToUserHomes(recipient, change(root, [{ id: members[0].email, read: true, write: false }]));
            const revoke = sendToUserHomes(recipient, change(root, null));
            await Bun.sleep(50);
            expect(held.peak()).toBe(1);

            const other = sendToUserHomes(recipient, change({ ...root, id: crypto.randomUUID() }, null));
            await Bun.sleep(50);
            expect(held.peak()).toBe(2);
            held.release();
            await Promise.all([add, revoke, other]);
        } finally {
            held.release();
        }
        const shared = await (await getHomeModule.getHome(members[0].id)).drive.getSharedPathsWithMe();
        expect(shared.some((path) => path.id === root.id)).toBe(false);
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

        await pullVisiblePaths(viewer, await getMemberships(viewer.id), rows);

        expect(aliceAsks.mock.calls.map((call) => call[2])).toEqual([[rows[0], rows[2]]]);
        expect(bobAsks.mock.calls.map((call) => call[2])).toEqual([[rows[1]]]);
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

describe('A graceful shutdown', () => {
    afterEach(() => {
        mock.restore();
    });

    test('waits for a direct send still delivering', async () => {
        const tag = 'relay-drain:direct';
        const held = holdMemberHomes();
        let drainedFirst: boolean;
        try {
            sendToHome(members[0].id, {
                type: 'notification',
                notification: { type: 'admin-alert', title: 'Direct', tag },
            }).catch(() => {});
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
            sendToUserHomes(
                members.map((member) => member.id),
                { type: 'notification', notification: { type: 'admin-alert', title: 'Detached', tag } },
            ).catch(() => {});
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

    // A delivery stuck on a home that never opens must not hold the shutdown, or eat the time the
    // mounts need to upload. The wait gives up at its bound and logs what is left.
    test('stops waiting for a delivery that never settles once the bound is over', async () => {
        const tag = 'relay-drain:stalled';
        const held = holdMemberHomes();
        const warnings = spyOn(console, 'warn').mockImplementation(() => {});
        let drainedFirst: boolean;
        let logged: unknown[][];
        try {
            sendToUserHomes([members[0].id], {
                type: 'notification',
                notification: { type: 'admin-alert', title: 'Stalled', tag },
            }).catch(() => {});
            drainedFirst = await answersFirst(drainDeliveriesWithin(100));
        } finally {
            logged = warnings.mock.calls;
            warnings.mockRestore();
            held.release();
        }
        expect(drainedFirst).toBe(true);
        expect(logged.some((call) => String(call[0]).includes('1 home deliveries'))).toBe(true);

        await drainHomeDeliveries();
        expect(await notificationsWithTag(members[0], tag)).toHaveLength(1);
    });
});
