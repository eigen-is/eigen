import { useAuth } from '@workspace/lib/auth';
import {
    formatEventTime,
    getCalendarColor,
    getDaysInRange,
    getEventsForDay,
    getInviteStatus,
    getWeekRange,
    isFreeBusyEvent,
    WEEKDAY_HEADERS,
} from '@workspace/lib/calendar';
import { isToday } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo } from 'react';
import { eventPillStateClasses } from './calendar-utils';
import { EventDetailDialog } from './event-detail-dialog';
import { useEventDetailState } from './hooks/use-event-detail-state';

type WeekViewProps = {
    currentDate: Date;
    events: CalendarEventOccurrence[];
    calendars: CalendarItem[];
    sharedCalendars?: SharedCalendar[];
    onDayClick?: (date: Date) => void;
    initialEventId?: string;
};

export function WeekView({
    currentDate,
    events,
    calendars,
    sharedCalendars,
    onDayClick,
    initialEventId,
}: WeekViewProps) {
    const { user } = useAuth();
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });

    const { startDate, endDate } = useMemo(() => getWeekRange(currentDate), [currentDate]);
    const days = useMemo(() => getDaysInRange(startDate, endDate), [startDate, endDate]);

    return (
        <>
            <div className="flex flex-col h-full">
                <div className="grid grid-cols-7 border-b">
                    {days.map((day, idx) => {
                        const today = isToday(day);
                        return (
                            <div key={idx} className="text-center py-2 border-r last:border-r-0">
                                <div className="text-xs font-medium text-muted-foreground">{WEEKDAY_HEADERS[idx]}</div>
                                <div
                                    className={cn(
                                        'text-lg font-medium mt-0.5 w-8 h-8 flex items-center justify-center rounded-full mx-auto',
                                        today && 'bg-primary text-primary-foreground',
                                    )}
                                >
                                    {day.getDate()}
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="flex-1 grid grid-cols-7 overflow-auto">
                    {days.map((day, dayIdx) => {
                        const dayEvents = getEventsForDay(events, day);
                        const allDayEvents = dayEvents.filter((e) => e.allDay);
                        const timedEvents = dayEvents
                            .filter((e) => !e.allDay)
                            .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

                        return (
                            <div
                                key={dayIdx}
                                className="border-r last:border-r-0 p-1 min-h-[400px] cursor-pointer hover:bg-accent/20 transition-colors"
                                onClick={() => onDayClick?.(day)}
                            >
                                <div className="space-y-0.5">
                                    {allDayEvents.map((event, idx) => {
                                        const freeBusy = isFreeBusyEvent(event);
                                        const color = getCalendarColor(event, calendars, sharedCalendars);
                                        const inviteStatus = freeBusy ? null : getInviteStatus(event, user?.email);
                                        return (
                                            <div
                                                key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                className={cn(
                                                    'text-xs leading-tight px-1.5 py-1 rounded text-white truncate',
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
                                    })}

                                    {allDayEvents.length > 0 && timedEvents.length > 0 && (
                                        <div className="border-b my-1" />
                                    )}

                                    {timedEvents.map((event, idx) => {
                                        const freeBusy = isFreeBusyEvent(event);
                                        const color = getCalendarColor(event, calendars, sharedCalendars);
                                        const inviteStatus = freeBusy ? null : getInviteStatus(event, user?.email);
                                        return (
                                            <div
                                                key={`${event.id}-${event.occurrenceDate}-${idx}`}
                                                className={cn(
                                                    'text-sm leading-tight flex items-start gap-1.5 py-0.5 px-0.5 rounded',
                                                    eventPillStateClasses('dot', freeBusy, inviteStatus),
                                                )}
                                                onClick={(e) => handleEventClick(event, e)}
                                                title={event.title}
                                            >
                                                <div
                                                    className={cn(
                                                        'h-2 w-2 rounded-full shrink-0 mt-1.5',
                                                        inviteStatus === 'pending' &&
                                                            'ring-1 ring-current bg-transparent',
                                                    )}
                                                    style={{
                                                        backgroundColor:
                                                            inviteStatus === 'pending' ? 'transparent' : color,
                                                        color,
                                                    }}
                                                />
                                                <div className="min-w-0">
                                                    <div className="text-muted-foreground text-sm">
                                                        {formatEventTime(event)}
                                                    </div>
                                                    <div className="truncate font-medium">{event.title}</div>
                                                    {event.location && (
                                                        <div className="text-muted-foreground text-sm truncate">
                                                            {event.location}
                                                        </div>
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

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}
