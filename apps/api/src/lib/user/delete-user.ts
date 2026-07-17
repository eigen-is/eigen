import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { auth, authDeleteUserReferences } from '../auth/auth';
import { getGuestHomePath, getUserHomePath } from '../config/paths';
import { ApiError } from '../core';
import { evictHome } from '../home/get-home';
import { getEigenDb } from '../share/db';
import { removeEntriesForTarget } from '../share/registry';
import { shareRegistry } from '../share/schema';
import type { User } from './user';
import { getUserById } from './user';

// Runs from the user.delete.before database hook in auth.ts — the one seam every
// better-auth deletion path passes through while the user row still exists — so the
// raw /auth/admin/remove-user endpoint tears down exactly as much as Eigen's own
// delete route. A throw here aborts better-auth's user-row deletion.
export async function teardownUserData(user: User): Promise<void> {
    // 1. Shut down cached Home singleton (closes databases, clears timeout)
    await evictHome(user.id);

    // 2. Delete user's home directory
    const homePath = user.role === 'guest' ? getGuestHomePath(user.id) : getUserHomePath(user.id);
    if (fs.existsSync(homePath)) {
        fs.rmSync(homePath, { recursive: true, force: true });
    }

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

    if (requestHeaders) {
        await auth.api.removeUser({ body: { userId }, headers: requestHeaders });
    } else {
        await (await auth.$context).internalAdapter.deleteUser(userId);
    }
}
