import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import {getUserByEmail} from '../user/';
import {getHome} from '../home';
import {getTeamMembers} from "../team";

export async function propagateACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
    const ids = new Set<string>();

    for (const acl of [...(oldACL || []), ...(newACL || [])]) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(acl.id);
            if (user) {
                ids.add(user.id);
            }
        } else if (parsed.type === 'team') {
            // get all members of team
            const team = await getTeamMembers(parsed.id);
            for (const member of team) {
                ids.add(member.user.id);
            }
        }
    }

    for (const id of ids) {
        try {
            const home = await getHome(id);
            await home.drive.receiveACLChange(path, newACL);
        } catch (error) {
            console.error('Failed to propagate ACL change:', error);
        }
    }
}
