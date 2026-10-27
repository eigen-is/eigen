// Deleting a user. teardownUserData removes what Eigen keeps for an account outside better-auth's user row, such
// as the home folder, its bucket objects, the share registry rows and the org memberships. better-auth's
// user.delete.before hook runs it, so every way to delete an account tears down the same data once, whoever
// starts it, such as an admin or the inactive-guest sweep.

import * as fs from 'node:fs';
import { auth, authDeleteUserReferences } from '../auth/auth';
import { requireHomeSlotFree } from '../backup/jobs';
import { collectHomeObjects, forgetSafetyCopySize } from '../backup/safety-copy';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { evictHome } from '../home/get-home';
import { removeEntriesForTarget, removeEntriesFromSource } from '../share/registry';
import type { User } from './user';
import { getUserById, isGuest } from './user';

// Enough of the keys a refusing bucket kept for an operator to clean up, without one log line per object.
const FAILED_KEYS_LOGGED = 50;

// Every better-auth deletion passes the user.delete.before hook while the user row still exists, so the hook runs
// this. A throw here stops better-auth from deleting the row.
export async function teardownUserData(user: User): Promise<void> {
    // A restore, safety-copy delete or capture of this home must finish first: it may hold the only good copy,
    // and a capture reads through the live Home the evict would close.
    requireHomeSlotFree(user.id);
    // 1. Close the loaded Home and its databases.
    await evictHome(user.id);
    // Again past the await: nothing awaits between this check and the deletes, so no job can take the slot in between.
    requireHomeSlotFree(user.id);

    // 2. Delete the home folder and the safety copies a restore left beside it. The bucket objects they name go
    //    in the background, so a bucket that refuses cannot keep the user.
    const homePath = isGuest(user) ? getGuestHomePath(user.id) : getUserHomePath(user.id);
    const { folders, objectCount, deleteObjects } = collectHomeObjects(homePath);
    for (const folder of folders) {
        fs.rmSync(folder, { recursive: true, force: true });
        forgetSafetyCopySize(folder);
    }
    // Nothing records these keys once the folders are gone: a restart mid-way leaves the operator this number.
    if (objectCount > 0) console.log(`[delete-user] deleting ${objectCount} bucket objects of ${user.id}`);
    deleteObjects()
        .then((failed) => {
            if (failed.length === 0) return;
            const more = failed.length > FAILED_KEYS_LOGGED ? `, and ${failed.length - FAILED_KEYS_LOGGED} more` : '';
            console.warn(
                `[delete-user] ${failed.length} bucket objects of ${user.id} could not be deleted: ${failed.slice(0, FAILED_KEYS_LOGGED).join(', ')}${more}`,
            );
        })
        .catch((error) => console.error(`[delete-user] deleting the bucket objects of ${user.id} failed:`, error));

    // 3. The share registry. Entries from this user always go. Entries addressed to a guest stay, so a guest who
    //    signs in again with a new code gets the same shares back.
    await removeEntriesFromSource(user.id);
    if (!isGuest(user)) {
        await removeEntriesForTarget(user.email);
    }

    // 4. The auth rows that point at the user, such as memberships, 2FA and app passwords. They go before the user
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
