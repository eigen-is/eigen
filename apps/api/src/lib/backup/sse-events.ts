import type { SSEventBackup } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

// The poke a job sends on every state change: a home job's to every admin, a server job's to the owner. The payload names the job and the home
// so the admin pane can refetch both lists; the job map on the server is the truth.
export function buildBackupJobEvent(jobId: string, ownerId: string): SSEventBackup {
    return { type: SSEventType.BACKUP_JOB_UPDATED, jobId, ownerId };
}
