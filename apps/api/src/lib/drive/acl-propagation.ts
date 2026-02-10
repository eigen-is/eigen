import type {DrivePath, DriveACL} from '@workspace/lib/types/drive';
import type {User} from 'better-auth/types';
import {getUserByEmail} from '../users/users';
import {getHome} from '../home';

/**
 * ACL Propagation Service
 * 
 * This module handles propagating ACL changes to all affected users' shared databases.
 * When a file/folder's ACL is modified, all users in both the old and new ACL need to be notified
 * so their local "shared with me" cache can be updated.
 * 
 * Current implementation: Direct in-process calls (monolith architecture)
 * Future implementation: HTTP calls to distributed user servers (when scaling horizontally)
 * 
 * The abstraction allows switching between implementations by only modifying this file,
 * without touching any of the Drive business logic that calls it.
 */

export async function propagateACLChange(path: DrivePath, oldACL: DriveACL[] | null, newACL: DriveACL[] | null): Promise<void> {
    const users = new Set(oldACL?.map(acl => acl.email) || []);
    newACL?.forEach(acl => users.add(acl.email));

    for (const email of users) {
        try {
            const user = await getUserByEmail(email);
            if (user) {
                const home = await getHome(user as User);
                await home.drive.receiveACLChange(path, newACL);
            }
        } catch (error) {
            console.error('Failed to propagate ACL change:', error);
        }
    }
}
