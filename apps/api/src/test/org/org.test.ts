import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
    organization as organizationSchema,
    teamMember as teamMemberSchema,
    team as teamSchema,
} from '../../../auth-schema';
import { getAuthDrizzleDb } from '../../lib/auth/auth';
import { getServerConfig, updateServerConfig } from '../../lib/config/server-config';
import { pinDefaultTeam } from '../../lib/org';
import { createTestUser, ensureServer } from '../setup';

// Installs set up before Eigen pinned the default team find it once at boot, by a rule a hand-made team can't meet.
describe('pinDefaultTeam', () => {
    let orgId: string;
    let orgName: string;
    let orgCreatedAt: Date;
    let setupTeamId: string;
    const madeTeamIds: string[] = [];

    function addTeam(name: string, createdAt: Date): string {
        const id = randomUUID();
        getAuthDrizzleDb().insert(teamSchema).values({ id, name, organizationId: orgId, createdAt }).run();
        madeTeamIds.push(id);
        return id;
    }

    beforeAll(async () => {
        await ensureServer();
        const config = getServerConfig();
        orgId = config?.orgId ?? '';
        setupTeamId = config?.defaultTeamId ?? '';
        const org = getAuthDrizzleDb()
            .select({ name: organizationSchema.name, createdAt: organizationSchema.createdAt })
            .from(organizationSchema)
            .where(eq(organizationSchema.id, orgId))
            .get();
        orgName = org?.name ?? '';
        orgCreatedAt = org?.createdAt ?? new Date(0);
    });

    afterEach(async () => {
        getAuthDrizzleDb().delete(teamSchema).where(inArray(teamSchema.id, madeTeamIds)).run();
        madeTeamIds.length = 0;
        getAuthDrizzleDb().update(teamSchema).set({ name: orgName }).where(eq(teamSchema.id, setupTeamId)).run();
        await updateServerConfig({ defaultTeamId: undefined });
    });

    afterAll(async () => {
        await updateServerConfig({ defaultTeamId: setupTeamId });
    });

    test('pins the team named after the organization and made with it', async () => {
        expect(setupTeamId).toBeTruthy();
        await updateServerConfig({ defaultTeamId: undefined });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBe(setupTeamId);
    });

    test('pins nothing when no team matches: a same-named team made later is not the default', async () => {
        getAuthDrizzleDb()
            .update(teamSchema)
            .set({ name: 'Renamed by hand' })
            .where(eq(teamSchema.id, setupTeamId))
            .run();
        addTeam(orgName, new Date(orgCreatedAt.getTime() + 60 * 60 * 1000));
        await updateServerConfig({ defaultTeamId: undefined });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBeUndefined();
    });

    test('pins a same-named team made 4 seconds after the organization', async () => {
        getAuthDrizzleDb()
            .update(teamSchema)
            .set({ name: 'Renamed by hand' })
            .where(eq(teamSchema.id, setupTeamId))
            .run();
        const inside = addTeam(orgName, new Date(orgCreatedAt.getTime() + 4_000));
        await updateServerConfig({ defaultTeamId: undefined });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBe(inside);
    });

    test('pins nothing for a same-named team made 6 seconds after the organization', async () => {
        getAuthDrizzleDb()
            .update(teamSchema)
            .set({ name: 'Renamed by hand' })
            .where(eq(teamSchema.id, setupTeamId))
            .run();
        addTeam(orgName, new Date(orgCreatedAt.getTime() + 6_000));
        await updateServerConfig({ defaultTeamId: undefined });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBeUndefined();
    });

    test('pins nothing when two teams match', async () => {
        addTeam(orgName, orgCreatedAt);
        await updateServerConfig({ defaultTeamId: undefined });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBeUndefined();
    });

    test('adds no existing member to the team it pins', async () => {
        await updateServerConfig({ defaultTeamId: undefined });
        const user = await createTestUser(`unpinned-${randomUUID()}@test.eigen.is`, 'testpassword123', 'Unpinned');
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBe(setupTeamId);
        const teamRows = getAuthDrizzleDb()
            .select({ teamId: teamMemberSchema.teamId })
            .from(teamMemberSchema)
            .where(eq(teamMemberSchema.userId, user.id))
            .all();
        expect(teamRows).toEqual([]);
    });

    test('keeps a pinned id', async () => {
        const pinned = addTeam('Everyone', new Date());
        await updateServerConfig({ defaultTeamId: pinned });
        await pinDefaultTeam();
        expect(getServerConfig()?.defaultTeamId).toBe(pinned);
    });
});
