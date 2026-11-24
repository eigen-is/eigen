// Calendar's mini month, at the foot of the sidebar: the focused month with today and the days the view shows
// marked. Its arrows browse months without moving the view, and a click on a day opens that day in the current view,
// closing the sidebar on a phone as a sidebar link does. Outside a view there is no mode, so a day opens on the start
// page, which picks the view for the device.

import { useNavigate } from '@tanstack/react-router';
import type { CalendarViewMode } from '@workspace/lib/calendar';
import { toLocalDateString, viewDays } from '@workspace/lib/calendar';
import { DateCalendar } from '@workspace/ui/components/date-calendar';
import { useLayout } from '@workspace/ui/components/layout/app';
import { useShowView } from './hooks/use-show-view';

export function MiniMonth({ mode, focus }: { mode?: CalendarViewMode; focus: Date }) {
    const navigate = useNavigate();
    const showView = useShowView();
    const { setSidebarOpen } = useLayout();
    const days = mode ? viewDays(mode, focus) : [];

    const openDay = (day: Date) => {
        if (mode) showView(mode, day);
        else navigate({ to: '/', search: { date: toLocalDateString(day) } });
        setSidebarOpen(false);
    };

    return (
        <DateCalendar
            className="w-full [--cell-size:--spacing(7)]"
            defaultMonth={focus}
            fixedWeeks
            modifiers={{ inView: days, viewStart: days.slice(0, 1), viewEnd: days.slice(-1) }}
            modifiersClassNames={{
                inView: 'bg-muted first:rounded-l-full last:rounded-r-full',
                viewStart: 'rounded-l-full',
                viewEnd: 'rounded-r-full',
            }}
            onDayClick={openDay}
        />
    );
}
