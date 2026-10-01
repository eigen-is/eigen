import { getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { describeError } from './errors';
import { alertOwner, hasScheduledAttemptOn } from './server-archives';
import { startServerBackup } from './server-job';

// The UTC day the owner last heard of a start that failed before it wrote its record.
let alertedOn: string | null = null;

// One scheduled attempt per UTC day, from the owner's hour on. The backups folder is the record of
// what ran, so a restart neither skips the night nor doubles it; one that kills the attempt costs it.
export async function serverBackupTick(): Promise<void> {
    const now = new Date();
    const { enabled, hourUtc, withS3 } = getServerSettings().backups.schedule;
    if (!enabled || now.getUTCHours() < hourUtc || hasScheduledAttemptOn(now)) return;
    try {
        await startServerBackup({ level: withS3 ? 'full-s3' : 'full', reason: 'scheduled' });
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
