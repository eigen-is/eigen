import { eq, max } from 'drizzle-orm';
import { session, user as userTable } from '../../../auth-schema';
import { getServerSettings } from '../config/server-settings';
import { atHome } from '../home/get-home';
import { deleteUserCompletely } from '../user/delete-user';
import { getAuthDrizzleDb } from './auth';

export type GuestCleanupResult = {
    deleted: string[];
    skipped: string[];
};

// Activity signal is MAX(session.updatedAt) — better-auth refreshes that on session
// validation, so it tracks "last time the guest hit an authenticated route" with
// roughly daily granularity. Falls back to user.updatedAt for guests that have no
// sessions yet (e.g. just-created accounts).
export async function cleanupInactiveGuests(): Promise<GuestCleanupResult> {
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
