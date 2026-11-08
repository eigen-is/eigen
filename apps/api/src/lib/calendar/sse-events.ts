// Builds the calendar events, which name the owner whose calendars or events changed. The Calendar sends
// them to its own tabs and to the homes a calendar is shared with.
// An invitation's event names the organizer instead.

import type { SSEventCalendar } from '@workspace/lib/types/sse';

export function buildCalendarEvent(type: SSEventCalendar['type'], ownerId: string): SSEventCalendar {
    return { type, ownerId };
}
