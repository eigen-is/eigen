import {eq} from "drizzle-orm";
import {organization} from "../../../auth-schema.ts";
import {getAuthDrizzleDb} from "../auth/auth.ts";

export async function getOrgExists(orgId: string) {
    const db = getAuthDrizzleDb();
    return await db.select({id: organization.id}).from(organization).where(eq(organization.id, orgId)).get() !== undefined;
}
