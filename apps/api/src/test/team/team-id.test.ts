import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getServerConfig } from '../../lib/config/server-config';
import { authedRequest, createTeam, getTestContext } from '../setup';

describe('Team routes take a team owner id', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        teamId = await createTeam(ctx, getServerConfig()!.orgId, 'Id Team');
    });

    test('the prefixed id lists the members', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/members`);
        expect(res.status).toBe(200);
    });

    test('a bare team id is a 400', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamId}/members`);
        expect(res.status).toBe(400);
    });
});
