// Small helpers the Calendar app's views and event dialogs share, such as the color and state an event draws in and
// the classes that state lays over its color surface, which occurrence a refetched list holds for one on screen, an
// event's start and end from the form's date and time fields, and the key a calendar picker names a calendar by.

import { getCalendarColor, getInviteStatus, isFreeBusyEvent, isSeriesOccurrence } from '@workspace/lib/calendar';
import type {
    CalendarEventOccurrence,
    CalendarItem,
    CalendarOption,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';

type EventPillVariant = 'block' | 'dot';

type EventSurfaceState = {
    past: boolean;
    freeBusy: boolean;
    inviteStatus: 'pending' | 'declined' | null;
};

// Every view reads an event's color and state here, so a past, free/busy, pending or declined event looks the same in
// each of them.
export function eventState(
    event: CalendarEventOccurrence,
    calendars: readonly CalendarItem[],
    sharedCalendars: readonly SharedCalendar[] | undefined,
    viewerEmail: string | undefined,
): EventSurfaceState & { color: string } {
    const freeBusy = isFreeBusyEvent(event);
    return {
        color: getCalendarColor(event, calendars, sharedCalendars),
        past: event.endTime <= new Date(),
        freeBusy,
        inviteStatus: freeBusy ? null : getInviteStatus(event, viewerEmail),
    };
}

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

// An override keeps the occurrence date and series of the occurrence it replaces. A lone event is its id alone, since
// its date moves with it.
export function isSameOccurrence(a: CalendarEventOccurrence, b: CalendarEventOccurrence): boolean {
    return (
        (a.parentEventId || a.id) === (b.parentEventId || b.id) &&
        (!isSeriesOccurrence(a) || !isSeriesOccurrence(b) || a.occurrenceDate === b.occurrenceDate)
    );
}

// A finger scrolls the views and its tap opens the event, so only the primary button of a mouse or pen drags.
export function isDragPointer(e: React.PointerEvent): boolean {
    return (e.pointerType === 'mouse' || e.pointerType === 'pen') && e.button === 0;
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
