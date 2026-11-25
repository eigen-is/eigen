// Calendar's start page, and where links from other apps land: it redirects to the default view on `?date=`, or on
// today, and keeps `?eventId=` and `?occurrence=` so the event opens there. The default is a week on a desktop and 3
// days on a phone, read from the window when the redirect runs. A signed-out visitor goes on to the login page from the
// view.

import { createFileRoute, redirect } from '@tanstack/react-router';
import { parseDayKey, toLocalDateString } from '@workspace/lib/calendar';
import { MOBILE_MEDIA_QUERY } from '@workspace/lib/media';

export const Route = createFileRoute('/')({
    validateSearch: (search: Record<string, unknown>): { date?: string; eventId?: string; occurrence?: string } => ({
        date: typeof search.date === 'string' ? search.date : undefined,
        eventId: typeof search.eventId === 'string' ? search.eventId : undefined,
        occurrence: typeof search.occurrence === 'string' ? search.occurrence : undefined,
    }),
    beforeLoad: ({ search }) => {
        const date = search.date && parseDayKey(search.date) ? search.date : toLocalDateString(new Date());
        throw redirect({
            to: '/view/$mode/$date',
            params: { mode: window.matchMedia(MOBILE_MEDIA_QUERY).matches ? '3day' : 'week', date },
            search: { eventId: search.eventId, occurrence: search.occurrence },
        });
    },
});
