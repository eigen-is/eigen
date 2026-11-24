// The Calendar app's month grid: every week the month touches, each day with up to four events, all-day ones first,
// then an "N more" that lists them all. A click on an event opens its detail dialog and a click on a day creates an
// event there; the route around it fetches the events.

import { getEventsForDay, viewDays, WEEKDAY_HEADERS } from '@workspace/lib/calendar';
import { isToday } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo } from 'react';
import { EventChip } from './event-chip';
import { EventDetailDialog } from './event-detail-dialog';
import { useEventDetailState } from './hooks/use-event-detail-state';
import { MonthDayPopover } from './month-day-popover';

type MonthViewProps = {
    focus: Date;
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    onDayClick?: (date: Date) => void;
    initialEventId?: string;
};

const MAX_VISIBLE_EVENTS = 4;

export function MonthView({ focus, events, calendars, sharedCalendars, onDayClick, initialEventId }: MonthViewProps) {
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });

    const days = useMemo(() => viewDays('month', focus), [focus]);
    const currentMonth = focus.getMonth();

    const weeks: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) {
        weeks.push(days.slice(i, i + 7));
    }

    return (
        <>
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-7 border-b">
                    {WEEKDAY_HEADERS.map((day) => (
                        <div
                            key={day}
                            className="text-center text-xs font-medium text-muted-foreground py-2 border-r last:border-r-0"
                        >
                            {day}
                        </div>
                    ))}
                </div>

                <div
                    className="flex-1 grid overflow-auto"
                    style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
                >
                    {weeks.map((week, weekIdx) => (
                        <div key={weekIdx} className="grid grid-cols-7 border-b last:border-b-0">
                            {week.map((day, dayIdx) => {
                                const dayEvents = getEventsForDay(events, day);
                                const allDayEvents = dayEvents.filter((e) => e.allDay);
                                const timedEvents = dayEvents
                                    .filter((e) => !e.allDay)
                                    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
                                const sortedEvents = [...allDayEvents, ...timedEvents];
                                const visibleEvents = sortedEvents.slice(0, MAX_VISIBLE_EVENTS);
                                const moreCount = sortedEvents.length - MAX_VISIBLE_EVENTS;
                                const isCurrentMonth = day.getMonth() === currentMonth;
                                const today = isToday(day);

                                return (
                                    <div
                                        key={dayIdx}
                                        className={cn(
                                            'border-r last:border-r-0 p-1 cursor-pointer hover:bg-accent/30 transition-colors',
                                            !isCurrentMonth && 'bg-muted/30',
                                        )}
                                        onClick={() => onDayClick?.(day)}
                                    >
                                        <div
                                            className={cn(
                                                'text-xs font-medium mb-0.5 w-6 h-6 flex items-center justify-center rounded-full',
                                                today && 'bg-primary text-primary-foreground',
                                                !isCurrentMonth && !today && 'text-muted-foreground',
                                            )}
                                        >
                                            {day.getDate()}
                                        </div>

                                        <div className="space-y-0.5">
                                            {visibleEvents.map((event, idx) => (
                                                <EventChip
                                                    key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                    event={event}
                                                    calendars={calendars}
                                                    sharedCalendars={sharedCalendars}
                                                    onClick={handleEventClick}
                                                />
                                            ))}
                                            {moreCount > 0 && (
                                                <MonthDayPopover
                                                    day={day}
                                                    events={sortedEvents}
                                                    hiddenCount={moreCount}
                                                    calendars={calendars}
                                                    sharedCalendars={sharedCalendars}
                                                    onEventClick={handleEventClick}
                                                />
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}
