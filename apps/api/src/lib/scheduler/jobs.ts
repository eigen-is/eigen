import { cleanupInactiveGuests } from '../auth/guest-cleanup';
import { scheduleInterval } from './scheduler';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function registerScheduledJobs(): void {
    scheduleInterval('guest-cleanup', ONE_DAY_MS, cleanupInactiveGuests);
}
