import { and, eq } from 'drizzle-orm';
import { organization, team } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../auth/auth';
import { getOrgName, getServerConfig, updateServerConfig } from '../config/server-config';
import { ApiError } from '../core/errors';

export async function getOrgExists(orgId: string) {
    const db = getAuthDrizzleDb();
    return (
        (await db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !==
        undefined
    );
}

// Two stores hold the name: better-auth's organization row, and config.json, which mail and branding read.
export async function renameOrganization(name: string, headers: Headers): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError(400, 'The organization needs a name');
    const orgId = getServerConfig()?.orgId;
    const db = getAuthDrizzleDb();
    const previous = orgId
        ? db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).get()
        : undefined;
    await auth.api.updateOrganization({
        body: { organizationId: orgId, data: { name: trimmed } },
        headers,
    });
    // Setup's default team is named after the organization; a team renamed by hand keeps its name.
    if (orgId && previous) {
        db.update(team)
            .set({ name: trimmed, updatedAt: new Date() })
            .where(and(eq(team.organizationId, orgId), eq(team.name, previous.name)))
            .run();
    }
    await updateServerConfig({ orgName: trimmed });
    return getOrgName();
}
