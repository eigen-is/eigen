import { eq } from 'drizzle-orm';
import { organization } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';

export async function getOrgExists(orgId: string) {
    const db = getAuthDrizzleDb();
    return (
        (await db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).get()) !==
        undefined
    );
}
