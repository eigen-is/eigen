// The questions another home may ask of a calendar, such as which calendars a home has, each with the handler that
// answers it on the owner's Home. Callers ask through the home relay's getFromHomes, and first leave out every owner
// without a home folder, so asking never creates a home. The relay spreads this table while it loads, so this file
// imports types only: a module that led back to the relay would make the relay run first and read the table before
// it exists.

import type { CalendarItem, SharedWithMeCalendar } from '@workspace/lib/types/calendar';
import type { Answerers } from '../home/home-relay';
import type { InvitationRequest } from './types';

export type CalendarQueries = {
    // Null when the home has no calendar, such as a guest's, or a team's while it is off.
    'calendar:calendars': { ask: null; answer: CalendarItem[] | null };
    'calendar:shares': {
        ask: { email: string; teamIds: string[] };
        answer: SharedWithMeCalendar[];
    };
    'calendar:pending-invitations': { ask: { attendeeEmail: string }; answer: InvitationRequest[] };
};

// The share kinds answer only what the home's own share rows give the asker. The calendars kind lists every calendar
// of the home, and its callers ask only the user's own teams.
export const answerCalendar: Answerers<CalendarQueries> = {
    'calendar:calendars': async (home) => (home.hasCalendar ? home.calendar.getCalendars() : null),
    'calendar:shares': async (home, ask) =>
        home.hasCalendar ? home.calendar.getSharedWith(ask.email, ask.teamIds) : [],
    'calendar:pending-invitations': async (home, ask) =>
        home.hasCalendar ? home.calendar.pendingInvitations(ask.attendeeEmail) : [],
};
