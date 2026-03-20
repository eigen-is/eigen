import type {DriveACL, DrivePath} from '@workspace/lib/types/drive';
import {parseOwnerId} from '@workspace/lib/types';
import {getUserByEmail} from '../user/';
import {getHome} from '../home';
import {getTeamMembers} from "../team";
import {addRegistryEntry} from '../share';

export async function resolveACLUserIds(ownerId: string, acls: DriveACL[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const acl of acls) {
        const parsed = parseOwnerId(acl.id);
        if (parsed.type === 'user') {
            const user = await getUserByEmail(acl.id);
            if (user) {
                ids.add(user.id);
            } else {
                await addRegistryEntry(ownerId, acl.id);
            }
        } else if (parsed.type === 'team') {
            await addRegistryEntry(ownerId, `team_${parsed.id}`);
            const team = await getTeamMembers(parsed.id);
            for (const member of team) {
                ids.add(member.user.id);
            }
        }
    }
    return ids;
}

export async function propagateACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
    const ids = await resolveACLUserIds(path.ownerId, [...(oldACL || []), ...(newACL || [])]);

    for (const id of ids) {
        try {
            const home = await getHome(id);
            await home.drive.receiveACLChange(path, newACL);
        } catch (error) {
            console.error('Failed to propagate ACL change:', error);
        }
    }
}
