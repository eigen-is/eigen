import type { CalendarEvent, CalendarShare, EventData } from '@workspace/lib/types/calendar';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Only `calendars` and `shared_calendars` are authoritative; the other tables rebuild from the files (docs/CALENDAR.md § Storage model — files as truth).

export const calendars = sqliteTable('calendars', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    isDefault: integer('isDefault', { mode: 'boolean' }).notNull().default(false),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    ctag: integer('ctag').notNull().default(0),
    // Rotated by a rebuild, so every sync token minted against the lost index is refused.
    syncGen: integer('syncGen').notNull().default(1),
    shares: text('shares', { mode: 'json' }).$type<CalendarShare[] | null>(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

// One row per stored file; the change tag sits here so a sync delta is one indexed scan of this table.
export const resources = sqliteTable(
    'resources',
    {
        id: text('id').primaryKey(),
        calendarId: text('calendarId')
            .notNull()
            .references(() => calendars.id, { onDelete: 'cascade' }),
        uri: text('uri').notNull(),
        uriKey: text('uriKey').notNull(),
        uid: text('uid').notNull(),
        etag: text('etag').notNull(),
        mtime: integer('mtime').notNull(),
        size: integer('size').notNull(),
        resourceCtag: integer('resourceCtag').notNull(),
        hasUnindexedRecurrence: integer('hasUnindexedRecurrence', { mode: 'boolean' }).notNull().default(false),
    },
    (table) => ({
        calendarKey: uniqueIndex('idx_resources_calendar_key').on(table.calendarId, table.uriKey),
        calendarUid: uniqueIndex('idx_resources_calendar_uid').on(table.calendarId, table.uid),
        // Home-wide, not per calendar: an import asks who holds a UID once per series of the file.
        resourceUid: index('idx_resources_uid').on(table.uid),
        calendarCtag: index('idx_resources_calendar_ctag').on(table.calendarId, table.resourceCtag),
    }),
);

// One row per VEVENT and per exclusion of a resource; the file's own facts, projected.
export const events = sqliteTable(
    'events',
    {
        id: text('id').primaryKey(),
        resourceId: text('resourceId')
            .notNull()
            .references(() => resources.id, { onDelete: 'cascade' }),
        calendarId: text('calendarId')
            .notNull()
            .references(() => calendars.id, { onDelete: 'cascade' }),
        uid: text('uid').notNull(),
        title: text('title').notNull(),
        description: text('description'),
        location: text('location'),
        startTime: integer('startTime', { mode: 'timestamp' }).notNull(),
        endTime: integer('endTime', { mode: 'timestamp' }).notNull(),
        allDay: integer('allDay', { mode: 'boolean' }).notNull().default(false),
        rrule: text('rrule'),
        timezone: text('timezone'),
        parentEventId: text('parentEventId'),
        recurrenceDate: text('recurrenceDate'),
        status: text('status').$type<CalendarEvent['status']>().notNull().default('confirmed'),
        data: text('data', { mode: 'json' }).$type<EventData | null>(),
        organizerEventId: text('organizerEventId'),
        organizerUserId: text('organizerUserId'),
        sequence: integer('sequence').notNull().default(0),
        createByUserId: text('createByUserId'),
        createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
        updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    },
    (table) => ({
        calendarStartTime: index('idx_events_calendar_start').on(table.calendarId, table.startTime),
        calendarEndTime: index('idx_events_calendar_end').on(table.calendarId, table.endTime),
        parentEvent: index('idx_events_parent').on(table.parentEventId),
        linkedEvent: index('idx_events_linked').on(table.organizerEventId, table.organizerUserId),
        resource: index('idx_events_resource').on(table.resourceId),
        uidCalendar: index('idx_events_uid_calendar').on(table.calendarId, table.uid),
        eventUid: index('idx_events_uid').on(table.uid),
    }),
);

// Keyed by the real name, cleared by the folded key: a re-create under another spelling drops the tombstone, so no href is both 200 and 404 in one delta.
export const resourceTombstones = sqliteTable(
    'resource_tombstones',
    {
        calendarId: text('calendarId').notNull(),
        uri: text('uri').notNull(),
        uriKey: text('uriKey').notNull(),
        deletedAtCtag: integer('deletedAtCtag').notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.calendarId, table.uri] }),
        calCtag: index('idx_resource_tombstones_cal_ctag').on(table.calendarId, table.deletedAtCtag),
        calKey: index('idx_resource_tombstones_cal_key').on(table.calendarId, table.uriKey),
    }),
);

// Durable write intent: while the row exists, the index owes that file a commit.
export const pendingWrites = sqliteTable(
    'pending_writes',
    {
        calendarId: text('calendarId')
            .notNull()
            .references(() => calendars.id, { onDelete: 'cascade' }),
        uri: text('uri').notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.calendarId, table.uri] }),
    }),
);

export const sharedCalendars = sqliteTable(
    'shared_calendars',
    {
        id: text('id').primaryKey(),
        ownerUserId: text('ownerUserId').notNull(),
        calendarId: text('calendarId').notNull(),
        calendarName: text('calendarName').notNull(),
        calendarColor: text('calendarColor').notNull(),
        permission: text('permission').$type<CalendarShare['permission']>().notNull(),
        color: text('color'),
        visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
        createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
        updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    },
    (table) => ({
        owner: index('idx_shared_calendars_ownerUserId').on(table.ownerUserId),
    }),
);
