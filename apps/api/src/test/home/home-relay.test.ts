import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { getServerConfig } from '../../lib/config/server-config';
import * as getHomeModule from '../../lib/home/get-home';
import { sendToHome } from '../../lib/home/home-relay';
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
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// Past the relay's delivery budget, so the fan-out has to queue.
const MEMBER_COUNT = 20;
const DELIVERY_BUDGET = 8;

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
    const teamId = await createTeam(ctx, orgId, 'Relay Budget Team');
    teamOwner = teamOwnerId(teamId);
    await addMember(ctx, teamId, ctx.alice.user.id);
    for (let i = 0; i < MEMBER_COUNT; i++) {
        const member = await createTestUser(`relay-member-${i}@test.eigen.is`, 'testpassword123', `Member ${i}`);
        await addMember(ctx, teamId, member.id);
        members.push(member);
    }
    await addTeamMount(ctx, teamId, 'Relay Budget Drive');
    teamMountId = await firstMountId(ctx.alice.user.sessionToken, teamOwner);
});

async function notificationsWithTag(member: TestUser, tag: string): Promise<Notification[]> {
    const rows = await assertJson<Notification[]>(
        await authedRequest(member.sessionToken, `/notifications/${member.id}`),
    );
    return rows.filter((row) => row.tag === tag);
}

// Holds every member's home at its opening until release(), and counts how many are opening at once.
function holdMemberHomes(): { peak: () => number; release: () => void } {
    const memberIds = new Set(members.map((member) => member.id));
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
    test('reaches every member of a team larger than the delivery budget', async () => {
        const tag = 'relay-budget:team-notification';
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

    test('to the watchers of a file opens at most the budget at once, after the write answers', async () => {
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
        expect(held.peak()).toBeGreaterThan(0);
        expect(held.peak()).toBeLessThanOrEqual(DELIVERY_BUDGET);
    });

    test('to everyone a chat message mentions opens at most the budget at once, after the post answers', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, teamOwner, teamMountId, 'root');
        const chat = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            teamOwner,
            teamMountId,
            `folder/${root.id}/create/chat`,
            { fileName: 'Relay Budget Chat' },
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
                return rows.find((row) => row.type === 'mention-chat' && row.title.includes('Relay Budget'));
            }, `the mention of ${member.email}`);
        }
        expect(held.peak()).toBeGreaterThan(0);
        expect(held.peak()).toBeLessThanOrEqual(DELIVERY_BUDGET);
    });
});
