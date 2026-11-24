// The calendar's main page: the signed-in user's own and shared events over the days one view shows, such as a week
// or a month. The URL names the view's mode and its focused local day, so switching mode keeps the day, and an
// unknown mode or day is the not-found page. A click on a month day opens the new-event dialog for that day, a slot or
// range picked in the time grid opens it at those times, and `?eventId=` opens that event's details.

import { createFileRoute, notFound } from '@tanstack/react-router';
import {
    isCalendarViewMode,
    parseDayKey,
    useAllSharedCalendarEvents,
    useCalendars,
    useEvents,
    useSharedCalendars,
    viewDays,
    viewRange,
} from '@workspace/lib/calendar';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { useMemo, useState } from 'react';
import { CalendarToolbar } from '../components/calendar-toolbar';
import type { NewEventTimes } from '../components/create-event-dialog';
import { CreateEventDialog } from '../components/create-event-dialog';
import { MonthView } from '../components/month-view';
import { ScheduleView } from '../components/schedule-view';
import { TimeGrid } from '../components/time-grid';

export const Route = createFileRoute('/_auth/view/$mode/$date')({
    beforeLoad: ({ params }) => {
        const focus = parseDayKey(params.date);
        if (!focus || !isCalendarViewMode(params.mode)) throw notFound();
        return { mode: params.mode, focus };
    },
    component: CalendarView,
    validateSearch: (search: Record<string, unknown>): { eventId?: string } => ({
        eventId: typeof search.eventId === 'string' ? search.eventId : undefined,
    }),
});

function CalendarView() {
    const { user, mode, focus } = Route.useRouteContext();
    const { eventId } = Route.useSearch();
    const ownerId = user.id;

    // What New event opens at while it is open: a clicked day, a picked range, or neither for the next quarter hour.
    const [creating, setCreating] = useState<{ date?: Date; times?: NewEventTimes } | null>(null);

    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);

    const days = useMemo(() => viewDays(mode, focus), [mode, focus]);
    const { from, to } = viewRange(mode, focus);
    const { data: ownEvents = [], isLoading } = useEvents(ownerId, from, to);
    const { data: sharedEvents = [] } = useAllSharedCalendarEvents(sharedCalendars, from, to);

    const allEvents = useMemo(() => {
        const visibleCalendarIds = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
        return [...ownEvents.filter((e) => visibleCalendarIds.has(e.calendarId)), ...sharedEvents];
    }, [calendars, ownEvents, sharedEvents]);

    return (
        <ColumnLayout>
            <Column
                id="calendar-main"
                width="flex"
                onBack="sidebar"
                toolbar={<CalendarToolbar mode={mode} focus={focus} onCreateEvent={() => setCreating({})} />}
            >
                {isLoading ? (
                    <LoadingState />
                ) : (
                    <div className="h-full">
                        {mode === 'month' ? (
                            <MonthView
                                focus={focus}
                                events={allEvents}
                                calendars={calendars}
                                sharedCalendars={sharedCalendars}
                                onDayClick={(date) => setCreating({ date })}
                                initialEventId={eventId}
                            />
                        ) : mode === 'schedule' ? (
                            <ScheduleView
                                days={days}
                                events={allEvents}
                                calendars={calendars}
                                sharedCalendars={sharedCalendars}
                                initialEventId={eventId}
                            />
                        ) : (
                            <TimeGrid
                                days={days}
                                events={allEvents}
                                calendars={calendars}
                                sharedCalendars={sharedCalendars}
                                initialEventId={eventId}
                                onCreateEvent={(times) => setCreating({ times })}
                            />
                        )}
                    </div>
                )}

                <CreateEventDialog
                    open={creating !== null}
                    onOpenChange={(open) => {
                        if (!open) setCreating(null);
                    }}
                    defaultDate={creating?.date}
                    initial={creating?.times}
                />
            </Column>
        </ColumnLayout>
    );
}
