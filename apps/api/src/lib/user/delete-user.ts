import * as fs from 'node:fs';
import {eq} from 'drizzle-orm';
import {member, teamMember} from '../../../auth-schema';
import {auth, getAuthDrizzleDb} from '../auth/auth';
import {getUserHomePath} from '../config/paths';
import {ApiError} from '../core';
import {evictHome} from '../home/get-home';
import {getEigenDb} from '../share/db';
import {removeEntriesForTarget} from '../share/registry';
import {shareRegistry} from '../share/schema';
import {getUserById} from './user';

export async function deleteUserCompletely(userId: string, requestHeaders: Headers): Promise<void> {
    const user = await getUserById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // 1. Shut down cached Home singleton (closes databases, clears timeout)
    await evictHome(userId);

    // 2. Delete user's home directory
    const homePath = getUserHomePath(userId);
    if (fs.existsSync(homePath)) {
        fs.rmSync(homePath, {recursive: true, force: true});
    }

    // 3. Clean up share registry — entries FROM this user and TO this user
    const eigenDb = await getEigenDb();
    eigenDb.delete(shareRegistry).where(eq(shareRegistry.fromUserId, userId)).run();
    await removeEntriesForTarget(user.email);

    // 4. Remove org/team memberships explicitly (PRAGMA foreign_keys is OFF by default
    //    in SQLite, so CASCADE from user deletion won't clean these up, and orphaned
    //    member rows crash better-auth's listMembers)
    const authDb = getAuthDrizzleDb();
    authDb.delete(teamMember).where(eq(teamMember.userId, userId)).run();
    authDb.delete(member).where(eq(member.userId, userId)).run();

    // 5. Delete user via better-auth (handles sessions, accounts, 2FA)
    await auth.api.removeUser({body: {userId}, headers: requestHeaders});
}
