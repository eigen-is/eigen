import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debounce } from 'es-toolkit';
import {
    invalidateCalendarCreated,
    invalidateCalendarDeleted,
    invalidateCalendarShared,
    invalidateCalendarUnshared,
    invalidateCalendarUpdated,
    invalidateEventUpdated,
} from './hooks/keys';

// A CalDAV device sync emits one event per resource (a whole-file import sends the one batched
// calendar:events-changed instead), and every resource's invalidation restarts the mounted range refetch —
// 500 events would mean 500 refetches per open tab, enough to trip the per-IP rate limiter. One trailing
// refetch per owner per burst instead; the writing tab's own onSuccess invalidation is untouched, so a
// single write still lands immediately.
const INVALIDATE_DEBOUNCE_MS = 250;
const debouncedEventInvalidations = new Map<string, (queryClient: QueryClient) => void>();

// The QueryClient travels as the argument (es-toolkit's debounce calls with the latest ones) rather than in
// the closure, which is stored for the owner's lifetime.
function invalidateEventsSoon(queryClient: QueryClient, ownerId: string): void {
    let run = debouncedEventInvalidations.get(ownerId);
    if (!run) {
        run = debounce((client: QueryClient) => invalidateEventUpdated(client, ownerId), INVALIDATE_DEBOUNCE_MS);
        debouncedEventInvalidations.set(ownerId, run);
    }
    run(queryClient);
}

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
