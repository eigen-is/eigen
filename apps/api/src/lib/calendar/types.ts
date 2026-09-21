import type { Attendee, CalendarEvent, CreateEventInput, EventData } from '@workspace/lib/types/calendar';

// Sender's SEQUENCE plus the instant it stamped: together they order two messages the way RFC 5546 § 2.1.5 does.
type MessageRevision = {
    sequence: number;
    dtstamp?: Date | null;
};

export type ReceiveInvitationPayload = MessageRevision & {
    uid: string;
    // Set when the message addresses ONE occurrence: its RECURRENCE-ID key, so the receiver attaches an exception instead of replacing the series.
    recurrenceDate?: string | null;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone: string | null;
    status: CalendarEvent['status'];
    data: EventData;
    createByUserId: string;
    organizerEventId: string;
    organizerUserId: string;
};

export type InvitationUpdatePayload = MessageRevision & {
    // Same rule as ReceiveInvitationPayload: an update naming an occurrence moves that instance only.
    recurrenceDate?: string | null;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone?: string | null;
    status: CalendarEvent['status'];
    attendees?: Attendee[];
};

// Inbound iMIP REQUEST/CANCEL naming one occurrence: attaches as an exception on the linked series.
export type InvitationExceptionPayload = MessageRevision & {
    recurrenceDate: string;
    // Absolute instant of a UTC-Z RECURRENCE-ID: lets the receiver re-key against the series timezone when the ICS carried none usable.
    recurrenceInstant?: Date | null;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    timezone: string | null;
    status: CalendarEvent['status'];
    attendees?: Attendee[];
};

// The wire shape minus the positional calendarId, plus the internal CalDAV fields the FE must never set.
export type CreateEventArgs = Omit<CreateEventInput, 'calendarId'> & {
    sequence?: number;
    // Set only by an invitation receiver: the organizer's stamp replaces the local clock so the next message can be ordered against it.
    dtstamp?: Date | null;
    createByUserId?: string | null;
    uid?: string | null;
};
