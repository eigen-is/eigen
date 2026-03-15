import type {QueryClient} from '@tanstack/react-query';
import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';
import {invalidateSpaceSettings} from './hooks/use-space-settings';

export function handleSpaceSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('space:')) return false;

    switch (event.type) {
        case SSEventType.SPACE_SETTINGS_UPDATED:
            invalidateSpaceSettings(queryClient);
            return true;

        default:
            return false;
    }
}
