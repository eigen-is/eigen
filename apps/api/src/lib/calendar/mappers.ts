import { createHash } from 'node:crypto';
import type { CalendarEvent, CalendarItem, EventData, SharedCalendar } from '@workspace/lib/types/calendar';
import type { CalendarEventRow } from './calendar';
import type * as schema from './schema';

export function computeEtag(event: {
    title: string;
    description?: string | null;
    location?: string | null;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    rrule?: string | null;
    timezone?: string | null;
    status: string;
    data?: EventData | null;
    updatedAt?: Date | null;
}): string {
    const hash = createHash('md5');
    hash.update(
        JSON.stringify({
            title: event.title,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            rrule: event.rrule,
            timezone: event.timezone,
            status: event.status,
            data: event.data,
            updatedAt: event.updatedAt,
        }),
    );
    return hash.digest('hex');
}

export function dbEventToCalendarEvent(row: typeof schema.events.$inferSelect): CalendarEvent {
    return {
        id: row.id,
        calendarId: row.calendarId,
        uid: row.uid,
        uri: row.uri,
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
        status: row.status as CalendarEvent['status'],
        sequence: row.sequence,
        etag: row.etag,
        data: row.data ?? null,
        createByUserId: row.createByUserId ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function dbEventToCalendarEventRow(row: typeof schema.events.$inferSelect): CalendarEventRow {
    return {
        ...dbEventToCalendarEvent(row),
        eventCtag: row.eventCtag ?? null,
    };
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
        permission: row.permission as SharedCalendar['permission'],
        color: row.color ?? null,
        visible: row.visible,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
