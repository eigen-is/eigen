// The calendar types the API and the Calendar app share: calendars, events and their occurrences, guests,
// reminders, sharing, the views a user picks from and the inputs that create or change them.

export const IMIP_METHODS = ['REQUEST', 'REPLY', 'CANCEL'] as const;
export type ImipMethod = (typeof IMIP_METHODS)[number];

// The views a user picks from, in the order every picker lists them. The bare list is what the settings route
// validates against.
export const CALENDAR_VIEW_MODES = ['day', '3day', 'week', 'month', 'schedule'] as const;
export type CalendarViewMode = (typeof CALENDAR_VIEW_MODES)[number];

export type Reminder = {
    type: 'notification' | 'email';
    minutes: number;
};

export type Attendee = {
    email: string;
    name?: string;
    status: 'pending' | 'accepted' | 'declined' | 'tentative';
    role: 'required' | 'optional';
};

// A guest's reply to an invitation: every status but the pending one before it.
export type RsvpStatus = Exclude<Attendee['status'], 'pending'>;

// `userId` is the organizer's Home, known only from the invitation link a guest's copy carries.
export type Organizer = { userId?: string; email: string; name?: string };

export type EventData = {
    reminders?: Reminder[];
    attendees?: Attendee[];
    organizer?: Organizer;
    organizerEventId?: string;
    url?: string;
    color?: string;
};

export const CALENDAR_SHARE_PERMISSIONS = ['free-busy', 'read', 'write'] as const;
type CalendarSharePermission = (typeof CALENDAR_SHARE_PERMISSIONS)[number];

export type CalendarShare = {
    targetId: string;
    permission: CalendarSharePermission;
};

// A calendar another owner shares with a user, with the strongest permission the user holds on it.
export type SharedWithMeCalendar = {
    calendarId: string;
    name: string;
    color: string;
    permission: CalendarSharePermission;
};

export type CalendarItem = {
    id: string;
    name: string;
    color: string;
    isDefault: boolean;
    visible: boolean;
    ctag: number;
    shares: CalendarShare[] | null;
    createdAt: Date;
    updatedAt: Date;
};

// One calendar a viewer may write in, own or shared, with the home it lives in: two homes can hold an id
// apiece, so a chooser needs both to name a target.
export type CalendarOption = {
    id: string;
    name: string;
    color: string;
    ownerId: string;
};

export type CalendarEvent = {
    id: string;
    calendarId: string;
    uid: string;
    uri: string;
    title: string;
    description: string | null;
    location: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule: string | null;
    timezone: string | null;
    parentEventId: string | null;
    recurrenceDate: string | null;
    status: 'confirmed' | 'tentative' | 'cancelled';
    sequence: number;
    etag: string;
    data: EventData | null;
    createByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export type CalendarEventOccurrence = CalendarEvent & {
    // The occurrence's key in its series, a YYYY-MM-DD day that stays when the occurrence moves.
    occurrenceDate: string;
};

// Which occurrences of a series a change or an answer applies to.
export const RECURRENCE_SCOPES = ['this', 'this-and-following', 'all'] as const;
export type RecurrenceScope = (typeof RECURRENCE_SCOPES)[number];

// One occurrence's save at a scope: `edited` is the occurrence as the save leaves it, and `seriesData` the master's
// data when the save changes it.
export type SaveOccurrenceInput = {
    occurrence: CalendarEventOccurrence;
    scope: RecurrenceScope;
    edited: Pick<
        CalendarEvent,
        'title' | 'description' | 'location' | 'allDay' | 'startTime' | 'endTime' | 'rrule' | 'timezone' | 'data'
    >;
    seriesData?: EventData;
};

export type FreeBusyBlock = {
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    status: 'confirmed' | 'tentative';
};

export type CreateEventInput = {
    calendarId: string;
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
    status?: 'confirmed' | 'tentative' | 'cancelled';
    data?: EventData | null;
    // The etag of the master an override is written into, as its dialog loaded it.
    etag?: string;
};

export type UpdateEventInput = {
    calendarId: string;
    id: string;
    etag: string;
    title?: string;
    startTime?: Date;
    endTime?: Date;
    allDay?: boolean;
    description?: string | null;
    location?: string | null;
    rrule?: string | null;
    timezone?: string | null;
    status?: 'confirmed' | 'tentative' | 'cancelled';
    data?: EventData | null;
};

export type UpdateCalendarInput = {
    id: string;
    name?: string;
    color?: string;
    visible?: boolean;
    shares?: CalendarShare[] | null;
};

export type UpdateSharedCalendarInput = {
    id: string;
    color?: string | null;
    visible?: boolean;
};

export type SharedCalendar = {
    id: string;
    ownerUserId: string;
    calendarId: string;
    calendarName: string;
    calendarColor: string;
    permission: CalendarSharePermission;
    color: string | null;
    visible: boolean;
    createdAt: Date;
    updatedAt: Date;
};
