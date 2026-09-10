import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateBackup } from './hooks/keys';

export function handleAdminSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('backup:')) return false;

    switch (event.type) {
        // The poke carries no job state: the job map on the server is the truth, so the pane refetches.
        case SSEventType.BACKUP_JOB_UPDATED:
            invalidateBackup(queryClient, event.ownerId);
            return true;

        default:
            return false;
    }
}
