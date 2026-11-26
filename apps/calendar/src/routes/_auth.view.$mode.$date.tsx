// The calendar's main page: the signed-in user's own and shared events over the days one view shows, such as a week
// or a month. The URL names the view's mode and its focused local day, so switching mode keeps the day, and an
// unknown mode or day is the not-found page. A click on an event opens its detail column at the right, which
// `?eventId=` and, for an occurrence of a series, `?occurrence=` name; on a phone it covers the grid. A click on a month
// day or a time grid slot opens New event there, or only closes an open event, and a drawn range opens it either way.

import { createFileRoute, notFound } from '@tanstack/react-router';
import {
    isCalendarViewMode,
    isFreeBusyEvent,
    isSeriesOccurrence,
    parseDayKey,
    useAllSharedCalendarEvents,
    useCalendars,
    useEvents,
    useSharedCalendars,
    viewDays,
    viewRange,
} from '@workspace/lib/calendar';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import {
    Column,
    ColumnLayout,
    DetailColumn,
    EmptyState,
    LoadingState,
    PhoneDetail,
    useLayout,
} from '@workspace/ui/components/layout/app';
import { useDetailHistory } from '@workspace/ui/hooks/use-detail-history';
import { useEffect, useMemo, useState } from 'react';
import { CalendarToolbar } from '../components/calendar-toolbar';
import { occurrenceKey } from '../components/calendar-utils';
import type { NewEventTimes } from '../components/create-event-dialog';
import { CreateEventDialog } from '../components/create-event-dialog';
import { EventDetail } from '../components/event-detail';
import type { EventKey } from '../components/hooks/use-event-detail-state';
import { eventKey, useEventDetailState } from '../components/hooks/use-event-detail-state';
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
    validateSearch: (search: Record<string, unknown>): { eventId?: string; occurrence?: string } => ({
        eventId: typeof search.eventId === 'string' ? search.eventId : undefined,
        occurrence: typeof search.occurrence === 'string' ? search.occurrence : undefined,
    }),
});

function CalendarView() {
    const { user, mode, focus } = Route.useRouteContext();
    const { eventId, occurrence } = Route.useSearch();
    const navigate = Route.useNavigate();
    const { isMobile } = useLayout();
    const ownerId = user.id;

    // What New event opens at while it is open: a clicked day, a picked range, or neither for the next quarter hour.
    const [creating, setCreating] = useState<{ date?: Date; times?: NewEventTimes } | null>(null);

    const { data: calendars = [], isLoading: calendarsLoading } = useCalendars(ownerId);
    const { data: sharedCalendars = [], isLoading: sharedLoading } = useSharedCalendars(ownerId);

    const days = useMemo(() => viewDays(mode, focus), [mode, focus]);
    const { from, to } = viewRange(mode, focus);
    const { data: ownEvents = [], isLoading } = useEvents(ownerId, from, to);
    const { data: sharedEvents = [], isLoading: sharedEventsLoading } = useAllSharedCalendarEvents(
        sharedCalendars,
        from,
        to,
    );

    const allEvents = useMemo(() => {
        const visibleCalendarIds = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
        return [...ownEvents.filter((e) => visibleCalendarIds.has(e.calendarId)), ...sharedEvents];
    }, [calendars, ownEvents, sharedEvents]);

    const listsLoading = isLoading || calendarsLoading || sharedLoading || sharedEventsLoading;

    const openEvent = eventId ? { eventId, occurrence } : undefined;
    const detailHistory = useDetailHistory<EventKey>(openEvent, (next, { replace, state }) =>
        navigate({
            search: (prev) => ({ ...prev, eventId: next?.eventId, occurrence: next?.occurrence }),
            replace,
            state,
        }),
    );
    const detailState = useEventDetailState({
        events: allEvents,
        calendars,
        sharedCalendars,
        open: openEvent,
        focus,
        onFollow: (next) => (next ? detailHistory.open(next) : detailHistory.close()),
    });
    const shown = detailState.event;
    const openKey = shown ? occurrenceKey(shown) : undefined;
    const handleEventClick = (event: CalendarEventOccurrence, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!isFreeBusyEvent(event)) detailHistory.open(eventKey(event));
    };

    // A link, such as an invitation's, names a series without a date, so the URL takes the date of the occurrence it
    // opened.
    const keylessDate =
        openEvent && !openEvent.occurrence && shown && isSeriesOccurrence(shown) && shown.occurrenceDate;
    useEffect(() => {
        if (keylessDate)
            void navigate({ search: (prev) => ({ ...prev, occurrence: keylessDate }), replace: true, state: true });
    }, [keylessDate, navigate]);

    // While an event is open the grid is its list: a click on it only closes the event, and a drawn range still creates.
    const pickNew = (picked: { date?: Date; times?: NewEventTimes }, drawn: boolean) => {
        if (openEvent) detailHistory.close();
        if (!openEvent || drawn) setCreating(picked);
    };

    const detail = !openEvent ? null : shown ? (
        <EventDetail
            key={`${openEvent.eventId}@${openEvent.occurrence ?? ''}`}
            {...detailState}
            event={shown}
            onClose={detailHistory.close}
        />
    ) : (
        <DetailColumn width="medium" onClose={detailHistory.close}>
            {listsLoading ? <LoadingState /> : <EmptyState message="This event isn't in this view" />}
        </DetailColumn>
    );

    return (
        <ColumnLayout>
            <PhoneDetail detail={detail}>
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
                                    onDayClick={(date) => pickNew({ date }, false)}
                                    onEventClick={handleEventClick}
                                    openKey={openKey}
                                    onSaved={detailState.onSaved}
                                />
                            ) : mode === 'schedule' ? (
                                <ScheduleView
                                    days={days}
                                    events={allEvents}
                                    calendars={calendars}
                                    sharedCalendars={sharedCalendars}
                                    onEventClick={handleEventClick}
                                    openKey={openKey}
                                />
                            ) : (
                                <TimeGrid
                                    days={days}
                                    events={allEvents}
                                    calendars={calendars}
                                    sharedCalendars={sharedCalendars}
                                    onEventClick={handleEventClick}
                                    openKey={openKey}
                                    onSaved={detailState.onSaved}
                                    onCreateEvent={(times, drawn) => pickNew({ times }, drawn)}
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
            </PhoneDetail>
            {!isMobile && detail}
        </ColumnLayout>
    );
}
