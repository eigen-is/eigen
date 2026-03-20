import * as fs from 'node:fs';
import {eq} from 'drizzle-orm';
import {getUserById} from './user';
import {getUserHomePath} from '../config/paths';
import {evictHome} from '../home/get-home';
import {removeEntriesForTarget} from '../share/registry';
import {getAuthDrizzleDb} from '../auth/auth';
import {ApiError} from '../core';
import {shareRegistry} from '../share/schema';
import {getEigenDb} from '../share/db';
import {user as userTable} from '../../../auth-schema';

export async function deleteUserCompletely(userId: string, requestingUserId: string): Promise<void> {
    if (userId === requestingUserId) {
        throw new ApiError(400, 'Cannot delete your own account');
    }

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
    eigenDb.delete(shareRegistry)
        .where(eq(shareRegistry.fromUserId, userId))
        .run();
    await removeEntriesForTarget(user.email);

    // 4. Delete user from auth DB (cascades to sessions, accounts, org/team memberships, 2FA)
    const authDb = getAuthDrizzleDb();
    authDb.delete(userTable).where(eq(userTable.id, userId)).run();
}
