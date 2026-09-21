import type { Attendee, CalendarEvent, CreateEventInput, EventData } from '@workspace/lib/types/calendar';

// Every scheduling message states the revision it carries: the sender's SEQUENCE and the instant it
// stamped, which together order two messages the way RFC 5546 § 2.1.5 does.
type MessageRevision = {
    sequence: number;
    dtstamp?: Date | null;
};

export type ReceiveInvitationPayload = MessageRevision & {
    uid: string;
    // Set when the message addresses ONE occurrence of the series: the wall-clock key its RECURRENCE-ID
    // names, so the receiver attaches it as an exception instead of replacing the whole series.
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

// A single moved/canceled occurrence of an externally-organized recurring invite (inbound iMIP
// REQUEST/CANCEL carrying a RECURRENCE-ID). Attaches as an exception on the linked series.
export type InvitationExceptionPayload = MessageRevision & {
    recurrenceDate: string;
    // Absolute instant of a UTC-Z RECURRENCE-ID (else undefined). Lets the receiver re-key against the
    // linked series' timezone when the ICS carried no usable tz (audit #8).
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

// The server-side input shape for Calendar.createEvent: the shared wire shape minus the calendarId the
// call takes positionally, plus the internal CalDAV fields the FE must never set. An update takes
// `EventPatch`, which is the same derivation of `UpdateEventInput` the format layer patches a VEVENT with.
export type CreateEventArgs = Omit<CreateEventInput, 'calendarId'> & {
    sequence?: number;
    // Set only by an invitation receiver: the instant the organizer's message stamped, stored in place of
    // the local clock so the next message can be ordered against it.
    dtstamp?: Date | null;
    createByUserId?: string | null;
    uid?: string | null;
};
