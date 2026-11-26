// Opens a Calendar view on a day, such as from the toolbar's arrows, a key or a click in the mini month. The URL holds
// the view's mode and its local day, so showing a view is a navigation, and it keeps the search, so an open event
// stays open.

import { useNavigate } from '@tanstack/react-router';
import type { CalendarViewMode } from '@workspace/lib/calendar';
import { toLocalDateString } from '@workspace/lib/calendar';

export function useShowView(): (mode: CalendarViewMode, day: Date) => void {
    const navigate = useNavigate();
    return (mode, day) =>
        void navigate({ to: '/view/$mode/$date', params: { mode, date: toLocalDateString(day) }, search: true });
}
