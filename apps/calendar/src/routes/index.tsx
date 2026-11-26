// Calendar's start page, and where links from other apps land: it opens the view the user last picked on this kind of
// device, a week on a computer and 3 days on a phone until they pick one, on `?date=` or on today. It keeps `?eventId=`
// and `?occurrence=`, so the event opens there. A signed-out visitor goes on to the login page from the view.

import { createFileRoute, Navigate } from '@tanstack/react-router';
import { parseDayKey, toLocalDateString, useCalendarViewPreference } from '@workspace/lib/calendar';

export const Route = createFileRoute('/')({
    validateSearch: (search: Record<string, unknown>): { date?: string; eventId?: string; occurrence?: string } => ({
        date: typeof search.date === 'string' ? search.date : undefined,
        eventId: typeof search.eventId === 'string' ? search.eventId : undefined,
        occurrence: typeof search.occurrence === 'string' ? search.occurrence : undefined,
    }),
    component: StartPage,
});

function StartPage() {
    const search = Route.useSearch();
    const { mode } = useCalendarViewPreference();
    const date = search.date && parseDayKey(search.date) ? search.date : toLocalDateString(new Date());
    return (
        <Navigate
            to="/view/$mode/$date"
            params={{ mode, date }}
            search={{ eventId: search.eventId, occurrence: search.occurrence }}
            replace
        />
    );
}
