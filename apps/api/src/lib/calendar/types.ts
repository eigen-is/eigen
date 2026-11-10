// Types the calendar store's own modules share, such as the arguments of an event write, and the link the home relay
// and inbound mail vouch for when a REQUEST arrives. The types the web app reads live with the shared calendar types.

import type { CreateEventInput } from '@workspace/lib/types/calendar';
import type { ParsedEvent } from '../ical/ical-parse';

// What the transport vouches for about an inbound REQUEST: the relay envelope, or a verified mail sender. None of it
// comes from the message body.
export type InvitationLink = {
    organizerEmail: string;
    organizerEventId: string;
    organizerUserId: string;
    createByUserId: string;
};

// A REQUEST from one Home to another: one series' events, or one occurrence's, and the link its envelope vouches for.
export type InvitationRequest = { events: readonly ParsedEvent[]; link: InvitationLink };

// The wire shape minus the positional calendarId, plus the fields only the server sets, which the web app never sends.
export type CreateEventArgs = Omit<CreateEventInput, 'calendarId'> & {
    sequence?: number;
    // Set only by an invitation receiver. The organizer's stamp replaces the local clock, so the next message can be
    // ordered against it, and a copy of one date keeps the instant the organizer's RECURRENCE-ID named.
    dtstamp?: Date | null;
    recurrenceInstant?: Date | null;
    createByUserId?: string | null;
    uid?: string | null;
};
