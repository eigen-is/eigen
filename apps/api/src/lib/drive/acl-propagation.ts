import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import {getUserByEmail} from '../user/';
import {getHome} from '../home';
import {eq} from 'drizzle-orm';
import {teamMember as teamMemberSchema, user as userSchema} from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';

export async function propagateACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
    const userEmails = new Set<string>();

    for (const acl of [...(oldACL || []), ...(newACL || [])]) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'user') {
            userEmails.add(acl.id.toLowerCase());
        } else if (parsed.type === 'team') {
            const members = await getTeamMemberEmails(parsed.id);
            for (const email of members) userEmails.add(email);
        }
    }

    for (const email of userEmails) {
        try {
            const user = await getUserByEmail(email);
            if (user) {
                const home = await getHome(user.id);
                await home.drive.receiveACLChange(path, newACL);
            }
        } catch (error) {
            console.error('Failed to propagate ACL change:', error);
        }
    }
}

async function getTeamMemberEmails(teamId: string): Promise<string[]> {
    try {
        const db = getAuthDrizzleDb();
        const members = await db.select({email: userSchema.email})
            .from(teamMemberSchema)
            .innerJoin(userSchema, eq(teamMemberSchema.userId, userSchema.id))
            .where(eq(teamMemberSchema.teamId, teamId))
            .all();
        return members.map(m => m.email.toLowerCase());
    } catch {
        return [];
    }
}
