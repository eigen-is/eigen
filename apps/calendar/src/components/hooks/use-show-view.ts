// Opens a Calendar view on a day, such as from the toolbar's arrows, a key or a click in the mini month. The URL holds
// the view's mode and its local day, so showing a view is a navigation, and it keeps the search, so an open event
// stays open. A switch to another view makes it the one the start page opens on this kind of device.

import { useMatch, useNavigate } from '@tanstack/react-router';
import { toLocalDateString, useCalendarViewPreference } from '@workspace/lib/calendar';
import type { CalendarViewMode } from '@workspace/lib/types/calendar';

export function useShowView(): (mode: CalendarViewMode, day: Date) => void {
    const navigate = useNavigate();
    const { setMode } = useCalendarViewPreference();
    const current = useMatch({ from: '/_auth/view/$mode/$date', shouldThrow: false })?.context.mode;
    return (mode, day) => {
        if (mode !== current) setMode(mode);
        void navigate({ to: '/view/$mode/$date', params: { mode, date: toLocalDateString(day) }, search: true });
    };
}
