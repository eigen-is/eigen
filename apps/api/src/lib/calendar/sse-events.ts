import type {SSEvent, SSEventCalendarData, SSEventCalendarShareData} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

type CalendarEventType =
    typeof SSEventType.CALENDAR_EVENT_CREATED
    | typeof SSEventType.CALENDAR_EVENT_UPDATED
    | typeof SSEventType.CALENDAR_EVENT_DELETED
    | typeof SSEventType.CALENDAR_CREATED
    | typeof SSEventType.CALENDAR_UPDATED
    | typeof SSEventType.CALENDAR_DELETED;

type CalendarShareEventType =
    typeof SSEventType.CALENDAR_SHARED
    | typeof SSEventType.CALENDAR_UNSHARED;

const calendarTemplates: Record<CalendarEventType, { title: string; body: (d: SSEventCalendarData) => string }> = {
    [SSEventType.CALENDAR_EVENT_CREATED]: {
        title: 'Event created',
        body: (d) => d.title ? `"${d.title}" created` : 'New event created',
    },
    [SSEventType.CALENDAR_EVENT_UPDATED]: {
        title: 'Event updated',
        body: (d) => d.title ? `"${d.title}" updated` : 'Event updated',
    },
    [SSEventType.CALENDAR_EVENT_DELETED]: {
        title: 'Event deleted',
        body: (d) => d.title ? `"${d.title}" deleted` : 'Event deleted',
    },
    [SSEventType.CALENDAR_CREATED]: {
        title: 'Calendar created',
        body: (d) => d.title ? `"${d.title}" created` : 'New calendar created',
    },
    [SSEventType.CALENDAR_UPDATED]: {
        title: 'Calendar updated',
        body: (d) => d.title ? `"${d.title}" updated` : 'Calendar updated',
    },
    [SSEventType.CALENDAR_DELETED]: {
        title: 'Calendar deleted',
        body: (d) => d.title ? `"${d.title}" deleted` : 'Calendar deleted',
    },
};

const shareTemplates: Record<CalendarShareEventType, { title: string; body: (d: SSEventCalendarShareData) => string }> = {
    [SSEventType.CALENDAR_SHARED]: {
        title: 'Calendar shared',
        body: (d) => `"${d.calendarName}" shared with you`,
    },
    [SSEventType.CALENDAR_UNSHARED]: {
        title: 'Calendar unshared',
        body: (d) => `"${d.calendarName}" is no longer shared with you`,
    },
};

export function buildCalendarEvent(type: CalendarEventType, data: SSEventCalendarData): SSEvent {
    const template = calendarTemplates[type];
    return {
        type,
        title: template.title,
        body: template.body(data),
        calendar: data,
    } as SSEvent;
}

export function buildCalendarShareEvent(type: CalendarShareEventType, data: SSEventCalendarShareData): SSEvent {
    const template = shareTemplates[type];
    return {
        type,
        title: template.title,
        body: template.body(data),
        calendarShare: data,
    } as SSEvent;
}
