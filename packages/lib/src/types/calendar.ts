export const IMIP_METHODS = ['REQUEST', 'REPLY', 'CANCEL'] as const;
export type ImipMethod = (typeof IMIP_METHODS)[number];

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

export type EventData = {
    reminders?: Reminder[];
    attendees?: Attendee[];
    organizer?: { userId: string; email: string; name?: string };
    organizerEventId?: string;
    url?: string;
    notes?: string;
    color?: string;
};

export type CalendarShare = {
    targetId: string;
    permission: 'free-busy' | 'read' | 'write';
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
    occurrenceDate: string;
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
};

export type UpdateEventInput = {
    calendarId: string;
    id: string;
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
    permission: 'free-busy' | 'read' | 'write';
    color: string | null;
    visible: boolean;
    createdAt: Date;
    updatedAt: Date;
};
