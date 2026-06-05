import { cleanupInactiveGuests } from '../auth/guest-cleanup';
import { registerSyncRetrySweep } from '../sync';
import { scheduleInterval } from './scheduler';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function registerScheduledJobs(): void {
    scheduleInterval('guest-cleanup', ONE_DAY_MS, cleanupInactiveGuests);
    // Re-drive backed-off pending uploads across live S3 mounts after a transient outage.
    registerSyncRetrySweep();
}
