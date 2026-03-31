import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CALENDAR_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'calendar',
    currentVersion: 3,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) =>
                db.exec(`
                CREATE TABLE IF NOT EXISTS calendars (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    isDefault INTEGER NOT NULL DEFAULT 0,
                    ctag INTEGER NOT NULL DEFAULT 0,
                    shares TEXT,
                    visible INTEGER NOT NULL DEFAULT 1,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    calendarId TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    location TEXT,
                    startTime INTEGER NOT NULL,
                    endTime INTEGER NOT NULL,
                    allDay INTEGER NOT NULL DEFAULT 0,
                    rrule TEXT,
                    timezone TEXT,
                    parentEventId TEXT,
                    recurrenceDate TEXT,
                    status TEXT NOT NULL DEFAULT 'confirmed',
                    etag TEXT NOT NULL,
                    data TEXT,
                    organizerEventId TEXT,
                    organizerUserId TEXT,
                    sequence INTEGER NOT NULL DEFAULT 0,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch()),
                    createByUserId TEXT,
                    FOREIGN KEY (calendarId) REFERENCES calendars(id) ON DELETE CASCADE,
                    FOREIGN KEY (parentEventId) REFERENCES events(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_events_calendar_start ON events(calendarId, startTime);
                CREATE INDEX IF NOT EXISTS idx_events_calendar_end ON events(calendarId, endTime);
                CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parentEventId);
                CREATE INDEX IF NOT EXISTS idx_events_linked ON events(organizerEventId, organizerUserId);

                CREATE TABLE IF NOT EXISTS shared_calendars (
                    id TEXT PRIMARY KEY,
                    ownerUserId TEXT NOT NULL,
                    calendarId TEXT NOT NULL,
                    calendarName TEXT NOT NULL,
                    calendarColor TEXT NOT NULL,
                    permission TEXT NOT NULL,
                    color TEXT,
                    visible INTEGER NOT NULL DEFAULT 1,
                    createdAt INTEGER DEFAULT (unixepoch()),
                    updatedAt INTEGER DEFAULT (unixepoch())
                );

                CREATE INDEX IF NOT EXISTS idx_shared_calendars_ownerUserId ON shared_calendars(ownerUserId);
            `),
        },
        {
            version: 2,
            up: (db) =>
                db.exec(`
                ALTER TABLE events ADD COLUMN icsBlob TEXT;
                ALTER TABLE events ADD COLUMN eventCtag INTEGER;
                CREATE TABLE IF NOT EXISTS event_tombstones (uri TEXT NOT NULL, calendarId TEXT NOT NULL, deletedAtCtag INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_tombstones_cal_ctag ON event_tombstones(calendarId, deletedAtCtag);
            `),
        },
        {
            version: 3,
            up: (db) =>
                db.exec(`
                DROP INDEX IF EXISTS idx_events_uri_calendar;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uri_calendar ON events(calendarId, uri);
            `),
        },
    ],
};
