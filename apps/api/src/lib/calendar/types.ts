import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';

// Internal type extending the shared CalendarEvent with CalDAV-only storage fields
export type CalendarEventRow = CalendarEvent & { eventCtag: number | null };

export type ReceiveInvitationPayload = {
    uid: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone: string | null;
    status: CalendarEvent['status'];
    sequence: number;
    data: EventData;
    createByUserId: string;
    organizerEventId: string;
    organizerUserId: string;
};

export type InvitationUpdatePayload = {
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone?: string | null;
    status: CalendarEvent['status'];
    sequence: number;
    attendees?: Attendee[];
};

// Server-side input shapes for Calendar.createEvent / updateEvent. Distinct from the shared
// `CreateEventInput` / `UpdateEventInput` (FE wire shape — see packages/lib/src/types/calendar.ts)
// because they (a) take calendarId as a separate positional arg and (b) carry internal CalDAV
// fields (createByUserId, uid, uri, sequence) that the FE must never set.
export type CreateEventArgs = {
    title: string;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    description?: string | null;
    location?: string | null;
    rrule?: string | null;
    timezone?: string | null;
    parentEventId?: string | null;
    recurrenceDate?: string | null;
    status?: CalendarEvent['status'];
    sequence?: number;
    data?: EventData | null;
    createByUserId?: string | null;
    uid?: string | null;
    uri?: string | null;
};

export type UpdateEventArgs = {
    title?: string;
    startTime?: Date;
    endTime?: Date;
    allDay?: boolean;
    description?: string | null;
    location?: string | null;
    rrule?: string | null;
    timezone?: string | null;
    status?: CalendarEvent['status'];
    sequence?: number;
    data?: EventData | null;
};
