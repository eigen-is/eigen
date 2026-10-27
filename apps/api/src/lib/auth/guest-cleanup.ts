// The daily sweep that deletes guests who have been inactive longer than guests.inactivityDays. The scheduler runs
// it at startup and every 24 hours. A guest whose home is loaded is skipped, so an open session is never pulled away,
// and the deletion is the same teardown as any other user's.

import { eq, max } from 'drizzle-orm';
import { session, user as userTable } from '../../../auth-schema';
import { isSetupRequired } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { atHome } from '../home/get-home';
import { deleteUserCompletely } from '../user/delete-user';
import { getAuthDrizzleDb } from './auth';

export type GuestCleanupResult = {
    deleted: string[];
    skipped: string[];
};

// A guest's last activity is the newest session.updatedAt, which better-auth moves forward about once a day while
// the guest makes requests. A guest without a session falls back to user.updatedAt.
export async function cleanupInactiveGuests(): Promise<GuestCleanupResult> {
    // The auth tables only exist once setup has run.
    if (isSetupRequired()) return { deleted: [], skipped: [] };

    const days = getServerSettings().guests.inactivityDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const db = getAuthDrizzleDb();
    const guests = db
        .select({ id: userTable.id, updatedAt: userTable.updatedAt })
        .from(userTable)
        .where(eq(userTable.role, 'guest'))
        .all();

    const deleted: string[] = [];
    const skipped: string[] = [];

    for (const guest of guests) {
        if (atHome(guest.id)) {
            skipped.push(guest.id);
            continue;
        }

        const sessionStat = db
            .select({ maxUpdated: max(session.updatedAt) })
            .from(session)
            .where(eq(session.userId, guest.id))
            .get();

        const lastActive = sessionStat?.maxUpdated ?? guest.updatedAt;
        if (lastActive >= cutoff) {
            skipped.push(guest.id);
            continue;
        }

        try {
            await deleteUserCompletely(guest.id, null);
            deleted.push(guest.id);
        } catch (error) {
            console.error(`[guest-cleanup] Failed to delete guest ${guest.id}:`, error);
            skipped.push(guest.id);
        }
    }

    if (deleted.length > 0 || skipped.length > 0) {
        console.log(
            `[guest-cleanup] cutoff=${cutoff.toISOString()} deleted=${deleted.length} skipped=${skipped.length}`,
        );
    }
    return { deleted, skipped };
}
