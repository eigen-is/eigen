import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
import {
    invalidateCalendarCreated,
    invalidateCalendarDeleted,
    invalidateCalendarShared,
    invalidateCalendarUnshared,
    invalidateCalendarUpdated,
    invalidateEventList,
} from './hooks/keys';

// Debounced for the fan-out of a whole-file import; the writing tab's own onSuccess invalidation still lands at once.
const invalidateEventsSoon = debouncePerOwner(invalidateEventList, 250);

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('calendar:')) return false;

    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
            invalidateCalendarCreated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_UPDATED:
            invalidateCalendarUpdated(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_DELETED:
            invalidateCalendarDeleted(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_EVENT_CREATED:
        case SSEventType.CALENDAR_EVENT_UPDATED:
        case SSEventType.CALENDAR_EVENT_DELETED:
        // The batched event stands for a burst of the three above, so it invalidates exactly what they do.
        case SSEventType.CALENDAR_EVENTS_CHANGED:
            invalidateEventsSoon(queryClient, event.ownerId);
            return true;

        case SSEventType.CALENDAR_SHARED:
            invalidateCalendarShared(queryClient, userId);
            return true;

        case SSEventType.CALENDAR_UNSHARED:
            invalidateCalendarUnshared(queryClient, userId);
            return true;

        // An invitation event names the ORGANIZER's home, so these invalidate the reader's own ranges.
        case SSEventType.CALENDAR_INVITE_RECEIVED:
        case SSEventType.CALENDAR_INVITE_UPDATED:
        case SSEventType.CALENDAR_INVITE_CANCELLED:
        case SSEventType.CALENDAR_INVITE_RSVP:
            invalidateEventsSoon(queryClient, userId);
            return true;

        default:
            return false;
    }
}
