// Types the calendar store's own modules share, such as the arguments of an event write, and the link the home relay
// and inbound mail vouch for when a REQUEST arrives. The types the web app reads live with the shared calendar types.

import type { CreateEventInput } from '@workspace/lib/types/calendar';

// What the transport vouches for about an inbound REQUEST: the relay envelope, or a verified mail sender. None of it
// comes from the message body.
export type InvitationLink = {
    organizerEmail: string;
    organizerEventId: string;
    organizerUserId: string;
    createByUserId: string;
};

// The wire shape minus the positional calendarId, plus the fields only the server sets, which the web app never sends.
export type CreateEventArgs = Omit<CreateEventInput, 'calendarId'> & {
    sequence?: number;
    // Set only by an invitation receiver: the organizer's stamp replaces the local clock so the next message can be ordered against it.
    dtstamp?: Date | null;
    createByUserId?: string | null;
    uid?: string | null;
};
