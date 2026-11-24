// The "N more" of a month day with more events than fit: it opens a list of every event of that day under its date,
// as Google Calendar does. Picking an event closes the list and opens the event's detail as a click in the day does.

import { formatDayMonth } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { useState } from 'react';
import { EventChip } from './event-chip';

type MonthDayPopoverProps = {
    day: Date;
    events: readonly CalendarEventOccurrence[];
    hiddenCount: number;
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    onEventClick: (event: CalendarEventOccurrence, e: React.MouseEvent) => void;
};

export function MonthDayPopover({
    day,
    events,
    hiddenCount,
    calendars,
    sharedCalendars,
    onEventClick,
}: MonthDayPopoverProps) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="block text-xs text-muted-foreground font-medium px-0.5 rounded cursor-pointer hover:bg-accent"
                    onClick={(e) => e.stopPropagation()}
                >
                    {hiddenCount} more
                </button>
            </PopoverTrigger>
            {/* React bubbles a click out of the portal to the day, which would open New event. */}
            <PopoverContent align="start" className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
                <div className="text-xs font-medium text-muted-foreground px-0.5 mb-1">
                    {formatDayMonth(day, { weekday: 'short' })}
                </div>
                <div className="space-y-0.5">
                    {events.map((event, idx) => (
                        <EventChip
                            key={`${event.id}-${event.occurrenceDate}-${idx}`}
                            event={event}
                            calendars={calendars}
                            sharedCalendars={sharedCalendars}
                            onClick={(clicked, e) => {
                                setOpen(false);
                                onEventClick(clicked, e);
                            }}
                        />
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}
