// One event in the month grid: an all-day event as a pill on its calendar's color surface, a timed one as a dot in
// that color, its time and its title, with the event's state over either, such as a past event dimmed or a pending
// invitation outlined. A month day and its list of all events, opened from "N more", draw their events with it; the
// click hands the event to the view's detail dialog.

import { useAuth } from '@workspace/lib/auth';
import { formatEventTime, getCalendarColor, getInviteStatus, isFreeBusyEvent } from '@workspace/lib/calendar';
import { indicatorColor } from '@workspace/lib/constants/colors';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import { eventSurfaceClasses } from './calendar-utils';

type EventChipProps = {
    event: CalendarEventOccurrence;
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    onClick: (event: CalendarEventOccurrence, e: React.MouseEvent) => void;
};

export function EventChip({ event, calendars, sharedCalendars, onClick }: EventChipProps) {
    const { user } = useAuth();
    const freeBusy = isFreeBusyEvent(event);
    const color = getCalendarColor(event, calendars, sharedCalendars);
    const inviteStatus = freeBusy ? null : getInviteStatus(event, user?.email);
    const state = { past: event.endTime <= new Date(), freeBusy, inviteStatus };

    if (event.allDay) {
        const surface = colorSurface(color);
        return (
            <div
                className={cn(
                    'text-xs leading-tight px-1 py-0.5 rounded truncate',
                    surface.className,
                    eventSurfaceClasses('block', state),
                )}
                style={surface.style}
                onClick={(e) => onClick(event, e)}
                title={event.title}
            >
                {event.title}
            </div>
        );
    }
    return (
        <div
            className={cn(
                'text-xs leading-tight flex items-center gap-1 truncate rounded px-0.5',
                eventSurfaceClasses('dot', state),
            )}
            onClick={(e) => onClick(event, e)}
            title={event.title}
        >
            <div
                className={cn(
                    'h-1.5 w-1.5 rounded-full shrink-0',
                    inviteStatus === 'pending' ? 'ring-1 ring-current' : 'bg-current',
                )}
                style={{ color: indicatorColor(color) }}
            />
            <span className="text-muted-foreground">{formatEventTime(event)}</span>
            <span className="truncate">{event.title}</span>
        </div>
    );
}
