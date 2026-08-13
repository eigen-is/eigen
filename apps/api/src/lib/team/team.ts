import { eq } from 'drizzle-orm';
import { team, teamMember, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';

export async function getTeam(teamId: string) {
    const db = getAuthDrizzleDb();
    return await db.select({ id: team.id, name: team.name }).from(team).where(eq(team.id, teamId)).get();
}

export async function getTeamExists(teamId: string) {
    return (await getTeam(teamId)) !== undefined;
}

export async function getTeamMembers(teamId: string) {
    const db = getAuthDrizzleDb();
    return db
        .select()
        .from(teamMember)
        .innerJoin(user, eq(teamMember.userId, user.id))
        .where(eq(teamMember.teamId, teamId))
        .all();
}
