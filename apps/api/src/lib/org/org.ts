// The deployment's one organization: whether it exists, the default team setup pins for it, and its rename, which two
// stores hold. Setup and the owner's settings call it.

import { and, eq } from 'drizzle-orm';
import { organization, team } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { getOrgName, getServerConfig, updateServerConfig } from '../config/server-config';
import { ApiError } from '../core/errors';

export async function getOrgExists(orgId: string): Promise<boolean> {
    const db = getAuthDrizzleDb();
    return (
        (await db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !==
        undefined
    );
}

// The team createOrganization made with the org, the only one it has while setup runs.
export function findDefaultTeamId(orgId: string): string | undefined {
    return getAuthDrizzleDb().select({ id: team.id }).from(team).where(eq(team.organizationId, orgId)).get()?.id;
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
