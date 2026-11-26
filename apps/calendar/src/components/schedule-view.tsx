// The Calendar app's schedule: a list of the days in view that have events, each under a heading with its date, and
// each event a row with a dot in its calendar's color, its time, its title and its place. A click on a row asks the
// route to open the event's detail, as a chip in the month grid does; the route picks the days, fetches the events and
// names the one it has open.

import { useAuth } from '@workspace/lib/auth';
import { dayEvents } from '@workspace/lib/calendar';
import { indicatorColor } from '@workspace/lib/constants/colors';
import { dateFormatter, formatMonth, formatTime, isToday } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { EmptyState } from '@workspace/ui/components/layout/app';
import { cn } from '@workspace/ui/lib/utils';
import { eventState, eventSurfaceClasses, occurrenceKey } from './calendar-utils';
import type { EventSurfaceProps } from './event-chip';
import { EventDot, openRing } from './event-chip';

type ScheduleViewProps = {
    days: readonly Date[];
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars: readonly SharedCalendar[];
    onEventClick: EventSurfaceProps['onClick'];
    openKey: string | undefined;
};

export function ScheduleView({ days, events, calendars, sharedCalendars, onEventClick, openKey }: ScheduleViewProps) {
    const { user } = useAuth();

    const scheduled = days
        .map((day) => ({ day, events: dayEvents(events, day) }))
        .filter((entry) => entry.events.length > 0);

    if (scheduled.length === 0) return <EmptyState message="Nothing planned" />;
    return (
        <div className="h-full overflow-auto">
            {scheduled.map(({ day, events: listed }) => (
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
                        {listed.map((event, idx) => {
                            const state = eventState(event, calendars, sharedCalendars, user?.email);
                            const key = occurrenceKey(event);
                            return (
                                <li key={`${event.id}-${event.occurrenceDate}-${idx}`}>
                                    <button
                                        type="button"
                                        className={cn(
                                            'flex w-full items-center gap-3 px-2 py-1.5 text-left text-sm',
                                            eventSurfaceClasses('dot', state),
                                            openRing(key, openKey),
                                        )}
                                        style={{ '--surface-indicator': indicatorColor(state.color) }}
                                        data-focus-key={key}
                                        onClick={(e) => onEventClick(event, e)}
                                    >
                                        <EventDot
                                            color={state.color}
                                            pending={state.inviteStatus === 'pending'}
                                            className="h-2.5 w-2.5"
                                        />
                                        <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                                            {event.allDay
                                                ? 'All day'
                                                : `${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}
                                        </span>
                                        <span className="truncate font-medium">{event.title}</span>
                                        {event.location && (
                                            <span className="truncate text-muted-foreground">{event.location}</span>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}
