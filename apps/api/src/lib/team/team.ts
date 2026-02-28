import {eq} from "drizzle-orm";
import {team} from "../../../auth-schema.ts";
import {getAuthDrizzleDb} from "../auth/auth.ts";


export async function getTeamExists(teamId: string) {
    const db = getAuthDrizzleDb();
    return await db.select({id: team.id}).from(team).where(eq(team.id, teamId)).get() !== undefined;
}