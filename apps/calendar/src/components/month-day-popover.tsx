// The "N more" of a month day with more events than fit: it opens a list of every event of that day under its date,
// as Google Calendar does. Picking an event closes the list and opens the event's detail as a click in the day does.

import { formatDayMonth } from '@workspace/lib/date';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { EventSurfaceProps } from './event-chip';
import { EventChip, MORE_BUTTON } from './event-chip';

type MonthDayPopoverProps = EventSurfaceProps & {
    day: Date;
    events: readonly CalendarEventOccurrence[];
    hiddenCount: number;
    style: CSSProperties;
};

export function MonthDayPopover({ day, events, hiddenCount, style, onClick, ...surfaceProps }: MonthDayPopoverProps) {
    const [open, setOpen] = useState(false);

    // Modal, so the page takes no pointer events while the list is open and a click on another day only closes it.
    return (
        <Popover open={open} onOpenChange={setOpen} modal>
            <PopoverTrigger asChild>
                <button type="button" className={MORE_BUTTON} style={style}>
                    {`${hiddenCount} more`}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
                <div className="text-xs font-medium text-muted-foreground px-0.5 mb-1">
                    {formatDayMonth(day, { weekday: 'short' })}
                </div>
                <div className="space-y-0.5">
                    {events.map((event, idx) => (
                        <EventChip
                            key={`${event.id}-${event.occurrenceDate}-${idx}`}
                            event={event}
                            {...surfaceProps}
                            onClick={(clicked, e) => {
                                setOpen(false);
                                onClick(clicked, e);
                            }}
                            className="w-full"
                        />
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}
