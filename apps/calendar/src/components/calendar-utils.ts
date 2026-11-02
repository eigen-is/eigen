// Small helpers the Calendar app's views and event dialogs share, such as the state classes of an event pill, an
// event's start and end from the form's date and time fields, and the key a calendar picker names a calendar by.

import type { CalendarOption } from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';

export type EventPillVariant = 'block' | 'dot';

// Shared by the MonthView and WeekView pills so both read a state the same way; their layout classes stay inline.
export function eventPillStateClasses(
    variant: EventPillVariant,
    freeBusy: boolean,
    inviteStatus: 'pending' | 'declined' | null,
): string {
    return cn(
        freeBusy
            ? 'opacity-50 cursor-default'
            : variant === 'block'
              ? 'cursor-pointer hover:opacity-80'
              : 'cursor-pointer hover:bg-accent',
        variant === 'block' &&
            inviteStatus === 'pending' &&
            'border border-dashed border-current bg-transparent !text-foreground',
        inviteStatus === 'declined' && 'opacity-40',
    );
}

// All-day bounds are midnight UTC with an exclusive end (docs/CALENDAR.md § An all-day event is midnight UTC with an exclusive end).
export function buildEventTimes(
    allDay: boolean,
    startDate: string,
    endDate: string,
    startTime: string,
    endTime: string,
): { start: Date; end: Date } {
    if (allDay) {
        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        return { start, end };
    }
    return { start: new Date(`${startDate}T${startTime}`), end: new Date(`${endDate}T${endTime}`) };
}

// A calendar's id is only unique within its owner's home, so a picker that lists several homes keys by both.
export function calendarKey(calendar: CalendarOption): string {
    return `${calendar.ownerId}:${calendar.id}`;
}
