import {createFileRoute} from '@tanstack/react-router'
import {useCallback, useMemo, useState} from 'react';
import {Column, ColumnLayout} from "@workspace/ui/components/layout";
import {useCalendars, useEvents, useSharedCalendars} from '@workspace/lib/calendar';
import {CalendarToolbar} from '../components/calendar-toolbar';
import {MonthView} from '../components/month-view';
import {WeekView} from '../components/week-view';
import {CreateEventDialog} from '../components/create-event-dialog';
import {getMonthRange, getWeekRange} from '../components/calendar-utils';
import type {ViewMode} from '../components/calendar-utils';
import type {CalendarEventOccurrence} from '@workspace/lib/types/calendar';
import {EigenLoader} from '@workspace/ui';

export const Route = createFileRoute('/_auth/view')({
    component: CalendarView,
})

function CalendarView() {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [viewMode, setViewMode] = useState<ViewMode>('month');
    const [createEventOpen, setCreateEventOpen] = useState(false);
    const [createEventDate, setCreateEventDate] = useState<Date | undefined>();

    const {data: calendars = []} = useCalendars();
    useSharedCalendars();

    const range = useMemo(() => {
        return viewMode === 'month'
            ? getMonthRange(currentDate)
            : getWeekRange(currentDate);
    }, [currentDate, viewMode]);

    const {data: ownEvents = [], isLoading} = useEvents(range.from, range.to);

    const allEvents = useMemo(() => {
        const events: CalendarEventOccurrence[] = [...ownEvents];
        return events;
    }, [ownEvents]);

    const handleToday = useCallback(() => setCurrentDate(new Date()), []);

    const handlePrev = useCallback(() => {
        setCurrentDate(prev => {
            const d = new Date(prev);
            if (viewMode === 'month') {
                d.setMonth(d.getMonth() - 1);
            } else {
                d.setDate(d.getDate() - 7);
            }
            return d;
        });
    }, [viewMode]);

    const handleNext = useCallback(() => {
        setCurrentDate(prev => {
            const d = new Date(prev);
            if (viewMode === 'month') {
                d.setMonth(d.getMonth() + 1);
            } else {
                d.setDate(d.getDate() + 7);
            }
            return d;
        });
    }, [viewMode]);

    const handleDayClick = useCallback((date: Date) => {
        setCreateEventDate(date);
        setCreateEventOpen(true);
    }, []);

    const defaultCalendarId = calendars.find(c => c.isDefault)?.id || calendars[0]?.id;

    return (
        <ColumnLayout>
            <Column
                id="calendar-main"
                width="flex"
                toolbar={
                    <CalendarToolbar
                        currentDate={currentDate}
                        viewMode={viewMode}
                        onViewModeChange={setViewMode}
                        onToday={handleToday}
                        onPrev={handlePrev}
                        onNext={handleNext}
                    />
                }
            >
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <EigenLoader/>
                    </div>
                ) : viewMode === 'month' ? (
                    <MonthView
                        currentDate={currentDate}
                        events={allEvents}
                        calendars={calendars}
                        onDayClick={handleDayClick}
                    />
                ) : (
                    <WeekView
                        currentDate={currentDate}
                        events={allEvents}
                        calendars={calendars}
                        onDayClick={handleDayClick}
                    />
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
