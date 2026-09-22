import type { SSEventCalendar } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildCalendarEvent(type: SSEventCalendar['type'], ownerId: string): SSEventCalendar {
    return { type, ownerId };
}

// What a bulk write broadcasts once for the per-resource events it held back.
export function buildEventsChangedEvent(ownerId: string): SSEventCalendar {
    return { type: SSEventType.CALENDAR_EVENTS_CHANGED, ownerId };
}
