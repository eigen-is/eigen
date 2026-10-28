// Deleting a user. teardownUserData removes what Eigen keeps for an account outside better-auth's user row, such
// as the home folder, its bucket objects, the share registry rows and the org memberships. better-auth's
// user.delete.before hook runs it, so every way to delete an account tears down the same data once, whoever
// starts it, such as an admin or the inactive-guest sweep.

import { auth, authDeleteUserReferences } from '../auth/auth';
import { requireHomeSlotFree } from '../backup/jobs';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { deleteHomeData } from '../home/delete-home';
import { removeEntriesForTarget, removeEntriesFromSource } from '../share/registry';
import { isGuest } from './guest';
import type { User } from './user';
import { getUserById } from './user';

// Every better-auth deletion passes the user.delete.before hook while the user row still exists, so the hook runs
// this. A throw here stops better-auth from deleting the row.
export async function teardownUserData(user: User): Promise<void> {
    // 1. The home folder, the safety copies a restore left beside it and their bucket objects.
    const homePath = isGuest(user) ? getGuestHomePath(user.id) : getUserHomePath(user.id);
    await deleteHomeData(user.id, homePath);

    // 2. The share registry. Entries from this user always go. Entries addressed to a guest stay, so a guest who
    //    signs in again with a new code gets the same shares back.
    await removeEntriesFromSource(user.id);
    if (!isGuest(user)) {
        await removeEntriesForTarget(user.email);
    }

    // 3. The auth rows that point at the user, such as memberships, 2FA and app passwords. They go before the user
    //    row, because a crash that left a member row without its user would break better-auth's listMembers.
    authDeleteUserReferences(user.id);
}

// Null `requestHeaders` deletes without a signed-in admin, as the inactive-guest sweep does. Both ways go through
// better-auth, which deletes the sessions and the accounts and then the user row, with teardownUserData in its hook.
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
