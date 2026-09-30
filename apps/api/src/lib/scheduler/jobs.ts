import { cleanupInactiveGuests } from '../auth/guest-cleanup';
import { hasScheduledAttemptOn, startServerBackup } from '../backup/server-job';
import { getServerSettings } from '../config/server-settings';
import { scheduleInterval } from './scheduler';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_BACKUP_TICK_MS = 5 * 60 * 1000;

// One scheduled attempt per UTC day, from the owner's hour on. The backups folder is the record of
// what ran, so a restart neither skips the night nor doubles it.
export async function serverBackupTick(): Promise<void> {
    const now = new Date();
    const { enabled, hourUtc, withS3, keep } = getServerSettings().backups.schedule;
    if (!enabled || now.getUTCHours() < hourUtc || hasScheduledAttemptOn(now)) return;
    await startServerBackup({ level: withS3 ? 'full-s3' : 'full', reason: 'scheduled', keep });
}

export function registerScheduledJobs(): void {
    scheduleInterval('guest-cleanup', ONE_DAY_MS, cleanupInactiveGuests);
    // Not at boot, when the server is busiest: a night the server was down for starts at the first tick.
    scheduleInterval('server-backup', SERVER_BACKUP_TICK_MS, serverBackupTick, { atStart: false });
}
