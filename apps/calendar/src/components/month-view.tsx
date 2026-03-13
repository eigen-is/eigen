import {useMemo, useState} from 'react';
import type {CalendarEventOccurrence, CalendarItem, SharedCalendar} from '@workspace/lib/types/calendar';
import {
    getMonthRange,
    getDaysInRange,
    getEventsForDay,
    isToday,
    formatEventTime,
    getCalendarColor,
    WEEKDAY_HEADERS,
} from './calendar-utils';
import {cn} from '@workspace/ui/lib/utils';
import {EventDetailDialog} from './event-detail-dialog';

type MonthViewProps = {
    currentDate: Date;
    events: CalendarEventOccurrence[];
    calendars: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
    onDayClick?: (date: Date) => void;
}

const MAX_VISIBLE_EVENTS = 4;

export function MonthView({currentDate, events, calendars, sharedCalendars, onDayClick}: MonthViewProps) {
    const [selectedEvent, setSelectedEvent] = useState<CalendarEventOccurrence | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    const {startDate, endDate} = useMemo(() => getMonthRange(currentDate), [currentDate]);
    const days = useMemo(() => getDaysInRange(startDate, endDate), [startDate, endDate]);
    const currentMonth = currentDate.getMonth();

    const weeks: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) {
        weeks.push(days.slice(i, i + 7));
    }

    const handleEventClick = (event: CalendarEventOccurrence, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedEvent(event);
        setDetailOpen(true);
    };

    const selectedCalendar = selectedEvent
        ? calendars.find(c => c.id === selectedEvent.calendarId) || null
        : null;

    const selectedSharedCalendar = selectedEvent && !selectedCalendar
        ? sharedCalendars?.find(s => s.calendarId === selectedEvent.calendarId) || null
        : null;

    return (
        <>
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-7 border-b">
                    {WEEKDAY_HEADERS.map((day) => (
                        <div key={day} className="text-center text-xs font-medium text-muted-foreground py-2 border-r last:border-r-0">
                            {day}
                        </div>
                    ))}
                </div>

                <div className={`flex-1 grid overflow-auto`} style={{gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))`}}>
                    {weeks.map((week, weekIdx) => (
                        <div key={weekIdx} className="grid grid-cols-7 border-b last:border-b-0">
                            {week.map((day, dayIdx) => {
                                const dayEvents = getEventsForDay(events, day);
                                const allDayEvents = dayEvents.filter(e => e.allDay);
                                const timedEvents = dayEvents.filter(e => !e.allDay).sort((a, b) => a.startTime - b.startTime);
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
                                            !isCurrentMonth && 'bg-muted/30'
                                        )}
                                        onClick={() => onDayClick?.(day)}
                                    >
                                        <div className={cn(
                                            'text-xs font-medium mb-0.5 w-6 h-6 flex items-center justify-center rounded-full',
                                            today && 'bg-primary text-primary-foreground',
                                            !isCurrentMonth && !today && 'text-muted-foreground'
                                        )}>
                                            {day.getDate()}
                                        </div>

                                        <div className="space-y-0.5">
                                            {visibleEvents.map((event, idx) => {
                                                const color = getCalendarColor(event, calendars, sharedCalendars);
                                                if (event.allDay) {
                                                    return (
                                                        <div
                                                            key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                            className="text-xs leading-tight px-1 py-0.5 rounded text-white truncate cursor-pointer hover:opacity-80"
                                                            style={{backgroundColor: color}}
                                                            onClick={(e) => handleEventClick(event, e)}
                                                            title={event.title}
                                                        >
                                                            {event.title}
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <div
                                                        key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                        className="text-xs leading-tight flex items-center gap-1 truncate cursor-pointer hover:bg-accent rounded px-0.5"
                                                        onClick={(e) => handleEventClick(event, e)}
                                                        title={event.title}
                                                    >
                                                        <div className="h-1.5 w-1.5 rounded-full shrink-0" style={{backgroundColor: color}}/>
                                                        <span className="text-muted-foreground">{formatEventTime(event)}</span>
                                                        <span className="truncate">{event.title}</span>
                                                    </div>
                                                );
                                            })}
                                            {moreCount > 0 && (
                                                <div className="text-xs text-muted-foreground font-medium px-0.5">
                                                    {moreCount} more
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            <EventDetailDialog
                open={detailOpen}
                onOpenChange={setDetailOpen}
                event={selectedEvent}
                calendar={selectedCalendar}
                sharedCalendar={selectedSharedCalendar}
            />
        </>
    );
}
