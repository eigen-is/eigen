import {drizzle} from 'drizzle-orm/bun-sqlite';
import {eq} from 'drizzle-orm';
import {getServerDataPath} from '../config/paths';
import {member as memberSchema, teamMember as teamMemberSchema} from '../../../auth-schema';

export type Memberships = {
    orgIds: string[];
    teamIds: string[];
};

/**
 * Resolves a user's org and team memberships from the auth database.
 */
export async function getMemberships(userId: string): Promise<Memberships> {
    const db = drizzle(getServerDataPath('users3.db'), {
        schema: {member: memberSchema, teamMember: teamMemberSchema},
    });

    const orgMembers = await db.select().from(memberSchema).where(eq(memberSchema.userId, userId)).all();
    const teamMembers = await db.select().from(teamMemberSchema).where(eq(teamMemberSchema.userId, userId)).all();

    return {
        orgIds: orgMembers.map(m => m.organizationId),
        teamIds: teamMembers.map(m => m.teamId),
    };
}

export type MembershipResolver = (userId: string) => Promise<Memberships>;
