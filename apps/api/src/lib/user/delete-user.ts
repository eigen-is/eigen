// Deletes a user and everything Eigen keeps for them: their home, their share-registry rows and the
// auth rows that point at them. Admin deletion and the inactive-guest cleanup call deleteUserCompletely,
// and better-auth's user-delete hook runs teardownUserData, so every way a user goes takes the same path.

import { eq } from 'drizzle-orm';
import { auth, authDeleteUserReferences } from '../auth/auth';
import { requireHomeSlotFree } from '../backup/jobs';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { deleteHomeData } from '../home/delete-home';
import { getEigenDb } from '../share/db';
import { removeEntriesForTarget } from '../share/registry';
import { shareRegistry } from '../share/schema';
import type { User } from './user';
import { getUserById } from './user';

// Runs from better-auth's user.delete.before hook, the one seam every deletion path passes through
// while the user row still exists. So the raw /auth/admin/remove-user endpoint tears down exactly as
// much as Eigen's own delete route. A throw here aborts the deletion of the user row.
export async function teardownUserData(user: User): Promise<void> {
    const homePath = user.role === 'guest' ? getGuestHomePath(user.id) : getUserHomePath(user.id);
    await deleteHomeData(user.id, homePath);

    // Share-registry rows from this user always go, rows to this user only for a non-guest. A guest's
    // rows stay, so signing in again with a code after the deletion finds the same shares.
    const eigenDb = await getEigenDb();
    eigenDb.delete(shareRegistry).where(eq(shareRegistry.fromUserId, user.id)).run();
    if (user.role !== 'guest') {
        await removeEntriesForTarget(user.email);
    }

    // The auth rows that point at the user, such as memberships, 2FA and API keys, go before the user
    // row. A crash halfway then can't leave a member row without a user, which breaks listMembers.
    // This also sweeps rows whose user is already gone, left by past bad deletions.
    authDeleteUserReferences(user.id);
}

// Pass null for `requestHeaders` to delete without an authenticated admin caller —
// used by the inactive-guest cleanup task. Both branches funnel through better-auth's
// deleteUser (session + account rows, then the user row), whose user.delete.before
// hook runs teardownUserData — so every entry point shares one deletion semantic and
// the teardown runs exactly once.
export async function deleteUserCompletely(userId: string, requestHeaders: Headers | null): Promise<void> {
    const user = await getUserById(userId);
    if (!user) {
        throw new ApiError(404, 'User not found');
    }
    // better-auth drops the sessions and the password before the hook can refuse, with no rollback.
    requireHomeSlotFree(userId);

    if (requestHeaders) {
        await auth.api.removeUser({ body: { userId }, headers: requestHeaders });
    } else {
        await (await auth.$context).internalAdapter.deleteUser(userId);
    }
}
