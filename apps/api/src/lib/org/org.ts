import { eq } from 'drizzle-orm';
import { organization } from '../../../auth-schema';
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
    await auth.api.updateOrganization({
        body: { organizationId: getServerConfig()?.orgId, data: { name: trimmed } },
        headers,
    });
    await updateServerConfig({ orgName: trimmed });
    return getOrgName();
}
