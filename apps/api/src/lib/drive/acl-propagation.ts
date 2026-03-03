import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import {getUserByEmail} from '../user/';
import {getHome} from '../home';
import {getTeamMemberEmails} from '../team/team';

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
