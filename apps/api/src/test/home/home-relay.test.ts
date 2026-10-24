import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { Notification } from '@workspace/lib/types/notification';
import { getServerConfig } from '../../lib/config/server-config';
import { sendToHome } from '../../lib/home/home-relay';
import type { TestContext, TestUser } from '../setup';
import { addMember, assertJson, authedRequest, createTeam, createTestUser, getTestContext } from '../setup';

// Past the relay's delivery budget, so the fan-out has to queue.
const MEMBER_COUNT = 20;

let ctx: TestContext;
let teamOwner: string;
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
    for (let i = 0; i < MEMBER_COUNT; i++) {
        const member = await createTestUser(`relay-member-${i}@test.eigen.is`, 'testpassword123', `Member ${i}`);
        await addMember(ctx, teamId, member.id);
        members.push(member);
    }
});

describe('A notification to a team', () => {
    test('reaches every member of a team larger than the delivery budget', async () => {
        const tag = 'relay-budget:team-notification';
        await sendToHome(teamOwner, {
            type: 'notification',
            notification: { type: 'admin-alert', title: 'To the whole team', tag },
        });

        for (const member of members) {
            const rows = await assertJson<Notification[]>(
                await authedRequest(member.sessionToken, `/notifications/${member.id}`),
            );
            expect(rows.filter((row) => row.tag === tag)).toHaveLength(1);
        }
    });
});
