// Builds the poke a backup job sends when it starts and when it ends, so an open admin pane refetches its
// job and artifact lists. It names the job and its home and carries no state: the job map on the server
// is the truth, so a poke that lands out of order costs nothing.

import type { SSEventBackup } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildBackupJobEvent(jobId: string, ownerId: string): SSEventBackup {
    return { type: SSEventType.BACKUP_JOB_UPDATED, jobId, ownerId };
}
