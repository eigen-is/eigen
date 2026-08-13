import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import {
    getMonthRange,
    getWeekRange,
    useAllSharedCalendarEvents,
    useCalendars,
    useEvents,
    useSharedCalendars,
    type ViewMode,
} from '@workspace/lib/calendar';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { useCallback, useMemo, useState } from 'react';
import { CalendarToolbar } from '../components/calendar-toolbar';
import { CreateEventDialog } from '../components/create-event-dialog';
import { MonthView } from '../components/month-view';
import { WeekView } from '../components/week-view';

export const Route = createFileRoute('/_auth/view/$mode/$from/$to')({
    component: CalendarView,
    validateSearch: (search: Record<string, unknown>): { eventId?: string } => ({
        eventId: typeof search.eventId === 'string' ? search.eventId : undefined,
    }),
});

function CalendarView() {
    const { mode, from: fromStr, to: toStr } = Route.useParams();
    const { eventId } = Route.useSearch();
    const navigate = useNavigate();
    const { user } = useAuth();
    const ownerId = user?.id || '';

    const viewMode = (mode === 'week' ? 'week' : 'month') as ViewMode;
    const from = Number(fromStr);
    const to = Number(toStr);

    const [createEventOpen, setCreateEventOpen] = useState(false);
    const [createEventDate, setCreateEventDate] = useState<Date | undefined>();

    const { data: calendars = [] } = useCalendars(ownerId);
    const { data: sharedCalendars = [] } = useSharedCalendars(ownerId);

    const currentDate = useMemo(() => {
        const midTs = (from + to) / 2;
        const mid = new Date(midTs * 1000);
        if (viewMode === 'month') {
            return new Date(mid.getFullYear(), mid.getMonth(), 1);
        }
        return mid;
    }, [from, to, viewMode]);

    const { data: ownEvents = [], isLoading } = useEvents(ownerId, from, to);
    const { data: sharedEvents = [] } = useAllSharedCalendarEvents(sharedCalendars, from, to);

    const visibleCalendarIds = useMemo(() => {
        return new Set(calendars.filter((c) => c.visible).map((c) => c.id));
    }, [calendars]);

    const allEvents = useMemo(() => {
        const filtered = ownEvents.filter((e) => visibleCalendarIds.has(e.calendarId));
        return [...filtered, ...sharedEvents];
    }, [ownEvents, visibleCalendarIds, sharedEvents]);

    const navigateToRange = useCallback(
        (newMode: ViewMode, newFrom: number, newTo: number) => {
            navigate({
                to: '/view/$mode/$from/$to',
                params: { mode: newMode, from: String(newFrom), to: String(newTo) },
                search: { eventId: undefined },
            });
        },
        [navigate],
    );

    const handleToday = useCallback(() => {
        const range = viewMode === 'month' ? getMonthRange(new Date()) : getWeekRange(new Date());
        navigateToRange(viewMode, range.from, range.to);
    }, [viewMode, navigateToRange]);

    const handlePrev = useCallback(() => {
        const d = new Date(currentDate);
        if (viewMode === 'month') {
            d.setMonth(d.getMonth() - 1);
        } else {
            d.setDate(d.getDate() - 7);
        }
        const range = viewMode === 'month' ? getMonthRange(d) : getWeekRange(d);
        navigateToRange(viewMode, range.from, range.to);
    }, [currentDate, viewMode, navigateToRange]);

    const handleNext = useCallback(() => {
        const d = new Date(currentDate);
        if (viewMode === 'month') {
            d.setMonth(d.getMonth() + 1);
        } else {
            d.setDate(d.getDate() + 7);
        }
        const range = viewMode === 'month' ? getMonthRange(d) : getWeekRange(d);
        navigateToRange(viewMode, range.from, range.to);
    }, [currentDate, viewMode, navigateToRange]);

    const handleViewModeChange = useCallback(
        (newMode: ViewMode) => {
            const range = newMode === 'month' ? getMonthRange(currentDate) : getWeekRange(currentDate);
            navigateToRange(newMode, range.from, range.to);
        },
        [currentDate, navigateToRange],
    );

    const handleDayClick = useCallback((date: Date) => {
        setCreateEventDate(date);
        setCreateEventOpen(true);
    }, []);

    const defaultCalendarId = calendars.find((c) => c.isDefault)?.id || calendars[0]?.id;

    return (
        <ColumnLayout>
            <Column
                id="calendar-main"
                width="flex"
                onBack="sidebar"
                toolbar={
                    <CalendarToolbar
                        currentDate={currentDate}
                        viewMode={viewMode}
                        onViewModeChange={handleViewModeChange}
                        onToday={handleToday}
                        onPrev={handlePrev}
                        onNext={handleNext}
                    />
                }
            >
                {isLoading ? (
                    <LoadingState />
                ) : (
                    <div className="h-full">
                        {viewMode === 'month' ? (
                            <MonthView
                                currentDate={currentDate}
                                events={allEvents}
                                calendars={calendars}
                                sharedCalendars={sharedCalendars}
                                onDayClick={handleDayClick}
                                initialEventId={eventId}
                            />
                        ) : (
                            <WeekView
                                currentDate={currentDate}
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
