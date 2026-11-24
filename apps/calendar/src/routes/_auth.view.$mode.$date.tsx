// The calendar's main page: the signed-in user's own and shared events over the days one view shows, such as a week
// or a month. The URL names the view's mode and its focused local day, so switching mode keeps the day, and an
// unknown mode or day is the not-found page. A click on a month day opens the new-event dialog for that day, a slot or
// range picked in the time grid opens it at those times, and `?eventId=` opens that event's details. Google's keys,
// such as t for today or m for month, work here while no dialog is open.

import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import {
    isCalendarViewMode,
    parseDayKey,
    toLocalDateString,
    useAllSharedCalendarEvents,
    useCalendarShortcuts,
    useCalendars,
    useEvents,
    useSharedCalendars,
    viewDays,
    viewRange,
} from '@workspace/lib/calendar';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { useDialogOpen } from '@workspace/ui/hooks/use-dialog-open';
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

    const [createEventOpen, setCreateEventOpen] = useState(false);
    const [createEventDate, setCreateEventDate] = useState<Date | undefined>();
    const [createEventTimes, setCreateEventTimes] = useState<NewEventTimes | undefined>();

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

    const handleDayClick = (date: Date) => {
        setCreateEventDate(date);
        setCreateEventTimes(undefined);
        setCreateEventOpen(true);
    };
    const handleCreateEvent = (times: NewEventTimes) => {
        setCreateEventTimes(times);
        setCreateEventOpen(true);
    };

    const navigate = useNavigate();
    useCalendarShortcuts({
        mode,
        focus,
        show: (nextMode, day) =>
            navigate({ to: '/view/$mode/$date', params: { mode: nextMode, date: toLocalDateString(day) } }),
        // As the sidebar's Create event, at the next quarter hour of today.
        create: () => {
            setCreateEventDate(undefined);
            setCreateEventTimes(undefined);
            setCreateEventOpen(true);
        },
        enabled: !useDialogOpen(),
    });

    const defaultCalendarId = calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id;

    return (
        <ColumnLayout>
            <Column
                id="calendar-main"
                width="flex"
                onBack="sidebar"
                toolbar={<CalendarToolbar mode={mode} focus={focus} />}
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
                                onDayClick={handleDayClick}
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
                                onCreateEvent={handleCreateEvent}
                            />
                        )}
                    </div>
                )}

                <CreateEventDialog
                    open={createEventOpen}
                    onOpenChange={setCreateEventOpen}
                    defaultDate={createEventDate}
                    initial={createEventTimes}
                    defaultCalendarId={defaultCalendarId}
                />
            </Column>
        </ColumnLayout>
    );
}
