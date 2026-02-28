import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/bun-sqlite";
import {getServerDataPath} from "../config/paths.ts";
import {account, member, organization, session, team, teamMember, user, verification} from "../../../auth-schema.ts";

function getTeamDb() {
    return drizzle(getServerDataPath('users3.db'), {
        schema: {
            user,
            session,
            verification,
            account,
            organization,
            team,
            member,
            teamMember
        },
    });
}

export async function getTeamExists(teamId: string) {
    const db = getTeamDb();
    return await db.select().from(team).where(eq(team.id, teamId)).get() !== undefined;
}