import type { CalendarEvent, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import type * as schema from './schema';

// The file facts an event row does not carry itself: one resource owns the name and the content hash, and
// every row it projects to reads them from there rather than keeping a copy that can drift.
export function dbEventToCalendarEvent(
    row: typeof schema.events.$inferSelect,
    resource: { uri: string; etag: string },
): CalendarEvent {
    return {
        id: row.id,
        calendarId: row.calendarId,
        uid: row.uid,
        uri: resource.uri,
        title: row.title,
        description: row.description ?? null,
        location: row.location ?? null,
        startTime: row.startTime,
        endTime: row.endTime,
        allDay: row.allDay,
        rrule: row.rrule ?? null,
        timezone: row.timezone ?? null,
        parentEventId: row.parentEventId ?? null,
        recurrenceDate: row.recurrenceDate ?? null,
        status: row.status,
        sequence: row.sequence,
        etag: resource.etag,
        data: row.data ?? null,
        createByUserId: row.createByUserId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

// An event row and the file it was projected from — what every read of a stored event answers with.
export type JoinedEvent = {
    events: typeof schema.events.$inferSelect;
    resources: { uri: string; etag: string };
};

export function toEvent(row: JoinedEvent): CalendarEvent {
    return dbEventToCalendarEvent(row.events, row.resources);
}

export function dbCalendarToCalendarItem(row: typeof schema.calendars.$inferSelect): CalendarItem {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        isDefault: row.isDefault,
        visible: row.visible,
        ctag: row.ctag,
        shares: row.shares ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function dbRowToSharedCalendar(row: typeof schema.sharedCalendars.$inferSelect): SharedCalendar {
    return {
        id: row.id,
        ownerUserId: row.ownerUserId,
        calendarId: row.calendarId,
        calendarName: row.calendarName,
        calendarColor: row.calendarColor,
        permission: row.permission,
        color: row.color ?? null,
        visible: row.visible,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
