import type { CalendarShare, EventData } from '@workspace/lib/types/calendar';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const calendars = sqliteTable('calendars', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    isDefault: integer('isDefault', { mode: 'boolean' }).notNull().default(false),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    ctag: integer('ctag').notNull().default(0),
    shares: text('shares', { mode: 'json' }).$type<CalendarShare[] | null>(),
    createdAt: integer('createdAt').default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt').default(sql`(unixepoch())`),
});

export const events = sqliteTable(
    'events',
    {
        id: text('id').primaryKey(),
        calendarId: text('calendarId')
            .notNull()
            .references(() => calendars.id, { onDelete: 'cascade' }),
        uid: text('uid').notNull(),
        uri: text('uri').notNull(),
        title: text('title').notNull(),
        description: text('description'),
        location: text('location'),
        startTime: integer('startTime').notNull(),
        endTime: integer('endTime').notNull(),
        allDay: integer('allDay', { mode: 'boolean' }).notNull().default(false),
        rrule: text('rrule'),
        timezone: text('timezone'),
        parentEventId: text('parentEventId'),
        recurrenceDate: text('recurrenceDate'),
        status: text('status').notNull().default('confirmed'),
        etag: text('etag').notNull(),
        data: text('data', { mode: 'json' }).$type<EventData | null>(),
        organizerEventId: text('organizerEventId'),
        organizerUserId: text('organizerUserId'),
        sequence: integer('sequence').notNull().default(0),
        createByUserId: text('createByUserId'),
        createdAt: integer('createdAt').default(sql`(unixepoch())`),
        updatedAt: integer('updatedAt').default(sql`(unixepoch())`),
        icsBlob: text('icsBlob'),
        eventCtag: integer('eventCtag'),
    },
    (table) => ({
        calendarStartTime: index('idx_events_calendar_start').on(table.calendarId, table.startTime),
        calendarEndTime: index('idx_events_calendar_end').on(table.calendarId, table.endTime),
        parentEvent: index('idx_events_parent').on(table.parentEventId),
        linkedEvent: index('idx_events_linked').on(table.organizerEventId, table.organizerUserId),
        uriCalendar: index('idx_events_uri_calendar').on(table.calendarId, table.uri),
        uidCalendar: index('idx_events_uid_calendar').on(table.calendarId, table.uid),
    }),
);

export const eventTombstones = sqliteTable(
    'event_tombstones',
    {
        uri: text('uri').notNull(),
        calendarId: text('calendarId').notNull(),
        deletedAtCtag: integer('deletedAtCtag').notNull(),
    },
    (table) => ({
        calCtag: index('idx_tombstones_cal_ctag').on(table.calendarId, table.deletedAtCtag),
    }),
);

export const sharedCalendars = sqliteTable('shared_calendars', {
    id: text('id').primaryKey(),
    ownerUserId: text('ownerUserId').notNull(),
    calendarId: text('calendarId').notNull(),
    calendarName: text('calendarName').notNull(),
    calendarColor: text('calendarColor').notNull(),
    permission: text('permission').notNull(),
    color: text('color'),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('createdAt').default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt').default(sql`(unixepoch())`),
});
