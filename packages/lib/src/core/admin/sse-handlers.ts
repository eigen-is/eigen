// Handles the backup job's poke from the stream: the admin pane refetches the jobs and archives of the
// home the poke names, or the server's archive list for a whole-server job.

import type { QueryClient } from '@tanstack/react-query';
import { parseOwnerId } from '@workspace/lib/types/owner';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateBackup, invalidateServerBackup } from './hooks/keys';

export function handleAdminSSEvent(event: SSEvent, queryClient: QueryClient): void {
    if (event.type !== SSEventType.BACKUP_JOB_UPDATED) return;
    // A server job's start and end write the record the server archive list shows.
    if (parseOwnerId(event.ownerId).type === 'org') invalidateServerBackup(queryClient, event.ownerId);
    else invalidateBackup(queryClient, event.ownerId);
}
