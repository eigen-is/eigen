export type Reminder = {
    type: 'notification' | 'email'
    minutes: number
}

export type Attendee = {
    email: string
    status: 'pending' | 'accepted' | 'declined' | 'tentative'
    role: 'required' | 'optional'
}

export type EventData = {
    reminders?: Reminder[]
    attendees?: Attendee[]
    organizer?: { userId: string; email: string }
    organizerEventId?: string
    url?: string
    notes?: string
    color?: string
}

export type CalendarShare = {
    targetId: string
    permission: 'free-busy' | 'read' | 'write'
}

export type CalendarItem = {
    id: string
    name: string
    color: string
    isDefault: boolean
    shares: CalendarShare[] | null
    createdAt: number
    updatedAt: number
}

export type CalendarEvent = {
    id: string
    calendarId: string
    uid: string
    uri: string
    title: string
    description: string | null
    location: string | null
    startTime: number
    endTime: number
    allDay: boolean
    rrule: string | null
    parentEventId: string | null
    recurrenceDate: string | null
    status: 'confirmed' | 'tentative' | 'cancelled'
    etag: string
    data: EventData | null
    createdAt: number
    updatedAt: number
}

export type CalendarEventOccurrence = CalendarEvent & {
    occurrenceDate: string
}

export type FreeBusyBlock = {
    startTime: number
    endTime: number
    allDay: boolean
    status: 'confirmed' | 'tentative'
}

export type SharedCalendar = {
    id: string
    ownerUserId: string
    calendarId: string
    calendarName: string
    calendarColor: string
    permission: 'free-busy' | 'read' | 'write'
    color: string | null
    visible: boolean
    createdAt: number
    updatedAt: number
}
