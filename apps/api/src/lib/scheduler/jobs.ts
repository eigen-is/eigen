import { cleanupInactiveGuests } from '../auth/guest-cleanup';
import { describeError } from '../backup/errors';
import { alertOwner, hasScheduledAttemptOn, startServerBackup } from '../backup/server-job';
import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { scheduleInterval } from './scheduler';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_BACKUP_TICK_MS = 5 * 60 * 1000;

// The UTC day the owner last heard of a start that failed before it wrote its record.
let alertedOn: string | null = null;

// One scheduled attempt per UTC day, from the owner's hour on. The backups folder is the record of
// what ran, so a restart neither skips the night nor doubles it.
export async function serverBackupTick(): Promise<void> {
    const now = new Date();
    const { enabled, hourUtc, withS3, keep } = getServerSettings().backups.schedule;
    if (!enabled || now.getUTCHours() < hourUtc || hasScheduledAttemptOn(now)) return;
    try {
        await startServerBackup({ level: withS3 ? 'full-s3' : 'full', reason: 'scheduled', keep });
    } catch (error) {
        // A 409 is another server backup running, and a start that wrote its record told the owner
        // itself. One that failed before it is tried every tick, so the owner hears of it once a day.
        const day = now.toISOString().slice(0, 10);
        const refused = error instanceof ApiError && error.status === 409;
        if (!refused && alertedOn !== day && !hasScheduledAttemptOn(now)) {
            alertedOn = day;
            alertOwner('schedule', describeError(error));
        }
        throw error;
    }
}

export function registerScheduledJobs(): void {
    scheduleInterval('guest-cleanup', ONE_DAY_MS, cleanupInactiveGuests);
    // Not at boot, when the server is busiest: a night the server was down for starts at the first tick.
    scheduleInterval('server-backup', SERVER_BACKUP_TICK_MS, serverBackupTick, { atStart: false });
}
