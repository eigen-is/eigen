import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { auth, authDeleteUserReferences } from '../auth/auth';
import { requireHomeSlotFree } from '../backup/jobs';
import { collectHomeObjects, forgetSafetyCopySize } from '../backup/safety-copy';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { evictHome } from '../home/get-home';
import { getEigenDb } from '../share/db';
import { removeEntriesForTarget } from '../share/registry';
import { shareRegistry } from '../share/schema';
import type { User } from './user';
import { getUserById } from './user';

// Enough of the keys a refusing bucket kept for an operator to clean up, without one log line per object.
const FAILED_KEYS_LOGGED = 50;

// Runs from the user.delete.before database hook in auth.ts — the one seam every
// better-auth deletion path passes through while the user row still exists — so the
// raw /auth/admin/remove-user endpoint tears down exactly as much as Eigen's own
// delete route. A throw here aborts better-auth's user-row deletion.
export async function teardownUserData(user: User): Promise<void> {
    // A restore, safety-copy delete or capture of this home must finish first: it may hold the only good copy,
    // and a capture reads through the live Home the evict would close.
    requireHomeSlotFree(user.id);
    // 1. Shut down cached Home singleton (closes databases, clears timeout)
    await evictHome(user.id);
    // Again past the await: nothing awaits between this check and the deletes, so no job can take the slot in between.
    requireHomeSlotFree(user.id);

    // 2. Delete user's home directory and the safety copies a restore left beside it, then the bucket objects
    //    they name, in the background: a bucket that refuses must not keep the user.
    const homePath = user.role === 'guest' ? getGuestHomePath(user.id) : getUserHomePath(user.id);
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

    // 3. Clean up share registry — entries FROM this user always; entries TO this user
    //    only for non-guests. Guest registry entries persist so re-OTP after deletion
    //    rehydrates the same shared.db state.
    const eigenDb = await getEigenDb();
    eigenDb.delete(shareRegistry).where(eq(shareRegistry.fromUserId, user.id)).run();
    if (user.role !== 'guest') {
        await removeEntriesForTarget(user.email);
    }

    // 4. Remove auth rows referencing the user (org/team membership, 2FA, API keys)
    //    before the user row goes, so a mid-flow crash can't leave the orphaned
    //    member rows that crash better-auth's listMembers. Also sweeps rows whose
    //    user is already gone, healing orphans from past bad deletions.
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
