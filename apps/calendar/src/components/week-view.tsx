import {useMemo, useState} from 'react';
import type {CalendarEventOccurrence, CalendarItem} from '@workspace/lib/types/calendar';
import {
    getWeekRange,
    getDaysInRange,
    getEventsForDay,
    isToday,
    formatEventTime,
    getCalendarColor,
    WEEKDAY_HEADERS,
} from './calendar-utils';
import {cn} from '@workspace/ui/lib/utils';
import {EventDetailDialog} from './event-detail-dialog';

type WeekViewProps = {
    currentDate: Date;
    events: CalendarEventOccurrence[];
    calendars: CalendarItem[];
    onDayClick?: (date: Date) => void;
}

export function WeekView({currentDate, events, calendars, onDayClick}: WeekViewProps) {
    const [selectedEvent, setSelectedEvent] = useState<CalendarEventOccurrence | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    const {startDate, endDate} = useMemo(() => getWeekRange(currentDate), [currentDate]);
    const days = useMemo(() => getDaysInRange(startDate, endDate), [startDate, endDate]);

    const handleEventClick = (event: CalendarEventOccurrence, e: React.MouseEvent) => {
        e.stopPropagation();
        setSelectedEvent(event);
        setDetailOpen(true);
    };

    const selectedCalendar = selectedEvent
        ? calendars.find(c => c.id === selectedEvent.calendarId) || null
        : null;

    return (
        <>
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-7 border-b">
                    {days.map((day, idx) => {
                        const today = isToday(day);
                        return (
                            <div key={idx} className="text-center py-2 border-r last:border-r-0">
                                <div className="text-xs font-medium text-muted-foreground">
                                    {WEEKDAY_HEADERS[idx]}
                                </div>
                                <div className={cn(
                                    'text-lg font-semibold mt-0.5 w-8 h-8 flex items-center justify-center rounded-full mx-auto',
                                    today && 'bg-primary text-primary-foreground'
                                )}>
                                    {day.getDate()}
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="flex-1 grid grid-cols-7 overflow-auto">
                    {days.map((day, dayIdx) => {
                        const dayEvents = getEventsForDay(events, day);
                        const allDayEvents = dayEvents.filter(e => e.allDay);
                        const timedEvents = dayEvents.filter(e => !e.allDay).sort((a, b) => a.startTime - b.startTime);

                        return (
                            <div
                                key={dayIdx}
                                className="border-r last:border-r-0 p-1 min-h-[400px] cursor-pointer hover:bg-accent/20 transition-colors"
                                onClick={() => onDayClick?.(day)}
                            >
                                <div className="space-y-0.5">
                                    {allDayEvents.map((event, idx) => {
                                        const color = getCalendarColor(event, calendars);
                                        return (
                                            <div
                                                key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                className="text-xs leading-tight px-1.5 py-1 rounded text-white truncate cursor-pointer hover:opacity-80"
                                                style={{backgroundColor: color}}
                                                onClick={(e) => handleEventClick(event, e)}
                                                title={event.title}
                                            >
                                                {event.title}
                                            </div>
                                        );
                                    })}

                                    {allDayEvents.length > 0 && timedEvents.length > 0 && (
                                        <div className="border-b my-1"/>
                                    )}

                                    {timedEvents.map((event, idx) => {
                                        const color = getCalendarColor(event, calendars);
                                        return (
                                            <div
                                                key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                className="text-xs leading-tight flex items-start gap-1.5 py-0.5 px-0.5 cursor-pointer hover:bg-accent rounded"
                                                onClick={(e) => handleEventClick(event, e)}
                                                title={event.title}
                                            >
                                                <div className="h-2 w-2 rounded-full shrink-0 mt-0.5" style={{backgroundColor: color}}/>
                                                <div className="min-w-0">
                                                    <div className="text-muted-foreground text-[10px]">{formatEventTime(event)}</div>
                                                    <div className="truncate font-medium">{event.title}</div>
                                                    {event.location && (
                                                        <div className="text-muted-foreground text-[10px] truncate">{event.location}</div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <EventDetailDialog
                open={detailOpen}
                onOpenChange={setDetailOpen}
                event={selectedEvent}
                calendar={selectedCalendar}
            />
        </>
    );
}
