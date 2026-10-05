import { and, eq } from 'drizzle-orm';
import { organization, team } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { getOrgName, getServerConfig, updateServerConfig } from '../config/server-config';
import { ApiError } from '../core/errors';

// createOrganization writes the org, its owner's member row and the default team in one call, so their
// timestamps are milliseconds apart, plus up to a second from the columns' second precision.
const DEFAULT_TEAM_MAX_GAP_MS = 5_000;

export async function getOrgExists(orgId: string) {
    const db = getAuthDrizzleDb();
    return (
        (await db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !==
        undefined
    );
}

// The team createOrganization made: named after the org and made with it. A team named like the org by hand
// came later, and an org that predates teams has none.
export function findDefaultTeamId(orgId: string): string | undefined {
    const db = getAuthDrizzleDb();
    const org = db
        .select({ name: organization.name, createdAt: organization.createdAt })
        .from(organization)
        .where(eq(organization.id, orgId))
        .get();
    if (!org) return undefined;
    const matches = db
        .select({ id: team.id, createdAt: team.createdAt })
        .from(team)
        .where(and(eq(team.organizationId, orgId), eq(team.name, org.name)))
        .all()
        .filter((t) => Math.abs(t.createdAt.getTime() - org.createdAt.getTime()) <= DEFAULT_TEAM_MAX_GAP_MS);
    return matches.length === 1 ? matches[0].id : undefined;
}

// For installs set up before setup pinned it. Existing members are not added: a removal and a never-added look alike.
export async function pinDefaultTeam(): Promise<void> {
    const config = getServerConfig();
    if (!config || config.defaultTeamId) return;
    const defaultTeamId = findDefaultTeamId(config.orgId);
    if (defaultTeamId) await updateServerConfig({ defaultTeamId });
}

// Two stores hold the name: better-auth's organization row, and config.json, which mail and branding read.
export async function renameOrganization(name: string, headers: Headers): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError(400, 'The organization needs a name');
    const config = getServerConfig();
    const orgId = config?.orgId;
    const db = getAuthDrizzleDb();
    const previous = orgId
        ? db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).get()
        : undefined;
    await auth.api.updateOrganization({
        body: { organizationId: orgId, data: { name: trimmed } },
        headers,
    });
    // The default team carries the organization's name; renamed by hand, it keeps its own.
    if (config?.defaultTeamId && previous) {
        db.update(team)
            .set({ name: trimmed, updatedAt: new Date() })
            .where(and(eq(team.id, config.defaultTeamId), eq(team.name, previous.name)))
            .run();
    }
    await updateServerConfig({ orgName: trimmed });
    return getOrgName();
}
