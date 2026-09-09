import type { SSEventBackup } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

// The poke a job sends to the admin who started it on every state change. The payload names the job
// and the home so the admin pane can refetch both lists; the job map on the server is the truth.
export function buildBackupJobEvent(jobId: string, ownerId: string): SSEventBackup {
    return { type: SSEventType.BACKUP_JOB_UPDATED, jobId, ownerId };
}
