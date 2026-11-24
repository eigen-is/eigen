// The calendar's main page: the signed-in user's own and shared events over the days one view shows, such as a week
// or a month. The URL names the view's mode and its focused local day, so switching mode keeps the day, and an
// unknown mode or day is the not-found page. A click on a day opens the new-event dialog for that day, and
// `?eventId=` opens that event's details.

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
import { CreateEventDialog } from '../components/create-event-dialog';
import { MonthView } from '../components/month-view';
import { WeekView } from '../components/week-view';

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

    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);

    const { from, to } = viewRange(mode, focus);
    const { data: ownEvents = [], isLoading } = useEvents(ownerId, from, to);
    const { data: sharedEvents = [] } = useAllSharedCalendarEvents(sharedCalendars, from, to);

    const allEvents = useMemo(() => {
        const visibleCalendarIds = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
        return [...ownEvents.filter((e) => visibleCalendarIds.has(e.calendarId)), ...sharedEvents];
    }, [calendars, ownEvents, sharedEvents]);

    const handleDayClick = (date: Date) => {
        setCreateEventDate(date);
        setCreateEventOpen(true);
    };

    const defaultCalendarId = calendars.find((c) => c.isDefault)?.id || calendars[0]?.id;

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
                        ) : (
                            <WeekView
                                days={viewDays(mode, focus)}
                                events={allEvents}
                                calendars={calendars}
                                sharedCalendars={sharedCalendars}
                                onDayClick={handleDayClick}
                                initialEventId={eventId}
                            />
                        )}
                    </div>
                )}

                <CreateEventDialog
                    open={createEventOpen}
                    onOpenChange={setCreateEventOpen}
                    defaultDate={createEventDate}
                    defaultCalendarId={defaultCalendarId}
                />
            </Column>
        </ColumnLayout>
    );
}
