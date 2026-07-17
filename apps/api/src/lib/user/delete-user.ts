import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { account, session, user as userTable } from '../../../auth-schema';
import { auth, authDeleteUserReferences, getAuthDrizzleDb } from '../auth/auth';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { evictHome } from '../home/get-home';
import { getEigenDb } from '../share/db';
import { removeEntriesForTarget } from '../share/registry';
import { shareRegistry } from '../share/schema';
import { getUserById } from './user';

// Pass null for `requestHeaders` to delete without an authenticated admin caller —
// used by the inactive-guest cleanup task. The admin API path runs better-auth's
// removal hooks; the system path mirrors the same effect by deleting auth rows
// directly (PRAGMA foreign_keys is OFF, so we can't rely on CASCADE).
export async function deleteUserCompletely(userId: string, requestHeaders: Headers | null): Promise<void> {
    const user = await getUserById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }

    // 1. Shut down cached Home singleton (closes databases, clears timeout)
    await evictHome(userId);

    // 2. Delete user's home directory
    const homePath = user.role === 'guest' ? getGuestHomePath(userId) : getUserHomePath(userId);
    if (fs.existsSync(homePath)) {
        fs.rmSync(homePath, { recursive: true, force: true });
    }

    // 3. Clean up share registry — entries FROM this user always; entries TO this user
    //    only for non-guests. Guest registry entries persist so re-OTP after deletion
    //    rehydrates the same shared.db state.
    const eigenDb = await getEigenDb();
    eigenDb.delete(shareRegistry).where(eq(shareRegistry.fromUserId, userId)).run();
    if (user.role !== 'guest') {
        await removeEntriesForTarget(user.email);
    }

    // 4. Remove auth rows referencing the user (org/team membership, 2FA, API keys)
    //    before the user row goes, so a mid-flow crash can't leave the orphaned
    //    member rows that crash better-auth's listMembers. Idempotent with the
    //    user.delete database hook that covers better-auth's own deletion paths.
    authDeleteUserReferences(userId);

    // 5. Delete the user — admin path delegates to better-auth (runs hooks, plugin
    //    cleanup); system path deletes the remaining auth rows directly.
    if (requestHeaders) {
        await auth.api.removeUser({ body: { userId }, headers: requestHeaders });
    } else {
        const authDb = getAuthDrizzleDb();
        authDb.delete(session).where(eq(session.userId, userId)).run();
        authDb.delete(account).where(eq(account.userId, userId)).run();
        authDb.delete(userTable).where(eq(userTable.id, userId)).run();
    }
}
