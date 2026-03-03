import {eq} from "drizzle-orm";
import {team, teamMember, user as userSchema} from "../../../auth-schema.ts";
import {getAuthDrizzleDb} from "../auth/auth.ts";

export async function getTeamExists(teamId: string) {
    const db = getAuthDrizzleDb();
    return await db.select({id: team.id}).from(team).where(eq(team.id, teamId)).get() !== undefined;
}

export async function getTeamMemberEmails(teamId: string): Promise<string[]> {
    try {
        const db = getAuthDrizzleDb();
        const members = await db.select({email: userSchema.email})
            .from(teamMember)
            .innerJoin(userSchema, eq(teamMember.userId, userSchema.id))
            .where(eq(teamMember.teamId, teamId))
            .all();
        return members.map(m => m.email.toLowerCase());
    } catch {
        return [];
    }
}