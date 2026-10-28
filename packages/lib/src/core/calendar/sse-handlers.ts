// Handles the calendar events from the stream. A change to a calendar refetches the calendar list, and
// a change to an event refetches the event ranges of the owner the event names. A burst of event changes
// refetches once.

import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
import {
    invalidateCalendarAccess,
    invalidateCalendarDeleted,
    invalidateCalendarList,
    invalidateEventList,
    invalidateSharedCalendars,
} from './hooks/keys';

// Debounced for the burst a whole-file import sends. The writing tab's own onSuccess still refetches at once.
const invalidateEventsSoon = debouncePerOwner(invalidateEventList, 250);

export function handleCalendarSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    switch (event.type) {
        case SSEventType.CALENDAR_CREATED:
        case SSEventType.CALENDAR_UPDATED:
            invalidateCalendarList(queryClient, event.ownerId);
            break;

        case SSEventType.CALENDAR_DELETED:
            invalidateCalendarDeleted(queryClient, event.ownerId);
            break;

        case SSEventType.CALENDAR_EVENT_CREATED:
        case SSEventType.CALENDAR_EVENT_UPDATED:
        case SSEventType.CALENDAR_EVENT_DELETED:
        // The batched event stands for a burst of the three above, so it invalidates exactly what they do.
        case SSEventType.CALENDAR_EVENTS_CHANGED:
            invalidateEventsSoon(queryClient, event.ownerId);
            break;

        case SSEventType.CALENDAR_SHARED:
        case SSEventType.CALENDAR_UNSHARED:
            invalidateSharedCalendars(queryClient, userId);
            // The event names the sharing owner, whose share dialog lists who has access.
            invalidateCalendarAccess(queryClient, event.ownerId);
            break;

        // An invitation event names the organizer's home, so these refetch the reader's own ranges.
        case SSEventType.CALENDAR_INVITE_RECEIVED:
        case SSEventType.CALENDAR_INVITE_UPDATED:
        case SSEventType.CALENDAR_INVITE_CANCELLED:
        case SSEventType.CALENDAR_INVITE_RSVP:
            invalidateEventsSoon(queryClient, userId);
            break;
    }
}
