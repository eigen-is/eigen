import type { SSEventCalendar } from '@workspace/lib/types/sse';

export function buildCalendarEvent(type: SSEventCalendar['type'], ownerId: string): SSEventCalendar {
    return { type, ownerId };
}
