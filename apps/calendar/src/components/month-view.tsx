import { useAuth } from '@workspace/lib/auth';
import {
    formatEventTime,
    getCalendarColor,
    getDaysInRange,
    getEventsForDay,
    getInviteStatus,
    getMonthRange,
    isFreeBusyEvent,
    isToday,
    WEEKDAY_HEADERS,
} from '@workspace/lib/calendar';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo } from 'react';
import { eventPillStateClasses } from './calendar-utils';
import { EventDetailDialog } from './event-detail-dialog';
import { useEventDetailState } from './hooks/use-event-detail-state';

type MonthViewProps = {
    currentDate: Date;
    events: CalendarEventOccurrence[];
    calendars: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
    onDayClick?: (date: Date) => void;
    initialEventId?: string;
};

const MAX_VISIBLE_EVENTS = 4;

export function MonthView({
    currentDate,
    events,
    calendars,
    sharedCalendars,
    onDayClick,
    initialEventId,
}: MonthViewProps) {
    const { user } = useAuth();
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });

    const { startDate, endDate } = useMemo(() => getMonthRange(currentDate), [currentDate]);
    const days = useMemo(() => getDaysInRange(startDate, endDate), [startDate, endDate]);
    const currentMonth = currentDate.getMonth();

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
                    className={`flex-1 grid overflow-auto`}
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
                                            {visibleEvents.map((event, idx) => {
                                                const freeBusy = isFreeBusyEvent(event);
                                                const color = getCalendarColor(event, calendars, sharedCalendars);
                                                const inviteStatus = freeBusy
                                                    ? null
                                                    : getInviteStatus(event, user?.email);
                                                if (event.allDay) {
                                                    return (
                                                        <div
                                                            key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                            className={cn(
                                                                'text-xs leading-tight px-1 py-0.5 rounded text-white truncate',
                                                                eventPillStateClasses('block', freeBusy, inviteStatus),
                                                            )}
                                                            style={
                                                                inviteStatus === 'pending'
                                                                    ? { borderColor: color, color }
                                                                    : { backgroundColor: color }
                                                            }
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
                                                        className={cn(
                                                            'text-xs leading-tight flex items-center gap-1 truncate rounded px-0.5',
                                                            eventPillStateClasses('dot', freeBusy, inviteStatus),
                                                        )}
                                                        onClick={(e) => handleEventClick(event, e)}
                                                        title={event.title}
                                                    >
                                                        <div
                                                            className={cn(
                                                                'h-1.5 w-1.5 rounded-full shrink-0',
                                                                inviteStatus === 'pending' &&
                                                                    'ring-1 ring-current bg-transparent',
                                                            )}
                                                            style={{
                                                                backgroundColor:
                                                                    inviteStatus === 'pending' ? 'transparent' : color,
                                                                color,
                                                            }}
                                                        />
                                                        <span className="text-muted-foreground">
                                                            {formatEventTime(event)}
                                                        </span>
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

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}
