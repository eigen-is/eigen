import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { invalidateSpaceSettings } from './hooks/keys';

export function handleSpaceSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('space:')) return false;

    switch (event.type) {
        case SSEventType.SPACE_SETTINGS_UPDATED:
            invalidateSpaceSettings(queryClient, userId);
            return true;

        default:
            return false;
    }
}
