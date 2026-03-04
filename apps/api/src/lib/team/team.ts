import {eq} from "drizzle-orm";
import {team, teamMember, user} from "../../../auth-schema.ts";
import {getAuthDrizzleDb} from "../auth/auth.ts";

export async function getTeamExists(teamId: string) {
    const db = getAuthDrizzleDb();
    return await db.select({id: team.id}).from(team).where(eq(team.id, teamId)).get() !== undefined;
}

export async function getTeamMembers(teamId: string) {
    try {
        const db = getAuthDrizzleDb();
        return db.select()
            .from(teamMember)
            .innerJoin(user, eq(teamMember.userId, user.id))
            .where(eq(teamMember.teamId, teamId))
            .all();
    } catch {
        return [];
    }
}