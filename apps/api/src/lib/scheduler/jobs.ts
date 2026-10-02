import { cleanupInactiveGuests } from '../auth/guest-cleanup';
import { serverBackupTick } from '../backup/schedule';
import { scheduleInterval } from './scheduler';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SERVER_BACKUP_TICK_MS = 5 * 60 * 1000;

export function registerScheduledJobs(): void {
    scheduleInterval('guest-cleanup', ONE_DAY_MS, cleanupInactiveGuests);
    // Not at boot, when the server is busiest: a night the server was down for starts at the first tick.
    scheduleInterval('server-backup', SERVER_BACKUP_TICK_MS, serverBackupTick, { atStart: false });
}
