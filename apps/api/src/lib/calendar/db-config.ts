import type {DatabaseConfig} from '../core/managed-database';
import * as schema from './schema';

export const CALENDAR_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'calendar',
    currentVersion: 1,
    schema,
    migrations: [
        {
            version: 1,
            up: (db) => db.exec(`
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
            `)
        }
    ]
};
