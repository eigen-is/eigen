// The Calendar app's schedule: a list of the days in view that have events, each under a heading with its date, and
// each event a row with a dot in its calendar's color, its time, its title and its place. A click on a row opens the
// event's detail dialog, as a chip in the month grid does; the route around it picks the days and fetches the events.

import { useAuth } from '@workspace/lib/auth';
import { getEventsForDay } from '@workspace/lib/calendar';
import { indicatorColor } from '@workspace/lib/constants/colors';
import { dateFormatter, formatMonth, formatTime, isToday } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { EmptyState } from '@workspace/ui/components/layout/app';
import { cn } from '@workspace/ui/lib/utils';
import { eventState, eventSurfaceClasses } from './calendar-utils';
import { EventDetailDialog } from './event-detail-dialog';
import { useEventDetailState } from './hooks/use-event-detail-state';

type ScheduleViewProps = {
    days: readonly Date[];
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    initialEventId?: string;
};

export function ScheduleView({ days, events, calendars, sharedCalendars, initialEventId }: ScheduleViewProps) {
    const { user } = useAuth();
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });

    const scheduled = days
        .map((day) => {
            const dayEvents = getEventsForDay(events, day);
            const timed = dayEvents
                .filter((e) => !e.allDay)
                .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            return { day, events: [...dayEvents.filter((e) => e.allDay), ...timed] };
        })
        .filter((entry) => entry.events.length > 0);

    return (
        <>
            {scheduled.length === 0 ? (
                <EmptyState message="Nothing planned" />
            ) : (
                <div className="h-full overflow-auto">
                    {scheduled.map(({ day, events: dayEvents }) => (
                        <section key={day.getTime()} className="flex gap-4 border-b px-4 py-2">
                            <h3 className="flex w-28 shrink-0 items-center gap-2 self-start text-xs font-medium uppercase text-muted-foreground">
                                <span
                                    className={cn(
                                        'flex h-8 w-8 items-center justify-center rounded-full text-lg text-foreground',
                                        isToday(day) && 'bg-(--app-current-color) text-background',
                                    )}
                                >
                                    {day.getDate()}
                                </span>
                                {`${formatMonth(day, 'short')}, ${dateFormatter({ weekday: 'short' }).format(day)}`}
                            </h3>
                            <ul className="min-w-0 flex-1">
                                {dayEvents.map((event, idx) => {
                                    const state = eventState(event, calendars, sharedCalendars, user?.email);
                                    return (
                                        <li key={`${event.id}-${event.occurrenceDate}-${idx}`}>
                                            <button
                                                type="button"
                                                className={cn(
                                                    'flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm',
                                                    eventSurfaceClasses('dot', state),
                                                )}
                                                onClick={(e) => handleEventClick(event, e)}
                                            >
                                                <span
                                                    className={cn(
                                                        'h-2.5 w-2.5 shrink-0 rounded-full',
                                                        state.inviteStatus === 'pending'
                                                            ? 'ring-1 ring-current'
                                                            : 'bg-current',
                                                    )}
                                                    style={{ color: indicatorColor(state.color) }}
                                                />
                                                <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                                                    {event.allDay
                                                        ? 'All day'
                                                        : `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}
                                                </span>
                                                <span className="truncate font-medium">{event.title}</span>
                                                {event.location && (
                                                    <span className="truncate text-muted-foreground">
                                                        {event.location}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}
