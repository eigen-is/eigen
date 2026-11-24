// Small helpers the Calendar app's views and event dialogs share, such as the state classes an event draws over its
// color surface, an event's start and end from the form's date and time fields, and the key a calendar picker names a
// calendar by.

import type { CalendarOption } from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';

type EventPillVariant = 'block' | 'dot';

type EventSurfaceState = {
    past: boolean;
    freeBusy: boolean;
    inviteStatus: 'pending' | 'declined' | null;
};

// Merged after colorSurface's classes, so a pending block's background replaces the fill. The past comes first, so a
// declined or free/busy fade wins over its dimming.
export function eventSurfaceClasses(variant: EventPillVariant, { past, freeBusy, inviteStatus }: EventSurfaceState) {
    return cn(
        past && 'opacity-60',
        freeBusy
            ? 'opacity-50 cursor-default'
            : variant === 'block'
              ? 'cursor-pointer hover:opacity-80'
              : 'cursor-pointer hover:bg-accent',
        variant === 'block' &&
            inviteStatus === 'pending' &&
            'border border-dashed bg-background text-foreground dark:bg-background dark:shadow-none',
        inviteStatus === 'declined' && 'opacity-40 line-through',
    );
}

// All-day bounds are midnight UTC with an exclusive end, so the last day counts one past it.
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
