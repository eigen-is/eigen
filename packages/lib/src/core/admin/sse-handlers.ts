import type { QueryClient } from '@tanstack/react-query';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateBackup, invalidateServerBackup } from './hooks/keys';

export function handleAdminSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('backup:')) return false;

    switch (event.type) {
        // The poke comes when a job starts or ends and carries no state: the job map on the server is the truth, so
        // the pane refetches. A server job's start and end write the record the archive list shows.
        case SSEventType.BACKUP_JOB_UPDATED:
            if (parseOwnerId(event.ownerId).type === 'org') invalidateServerBackup(queryClient, event.ownerId);
            else invalidateBackup(queryClient, event.ownerId);
            return true;

        default:
            return false;
    }
}
