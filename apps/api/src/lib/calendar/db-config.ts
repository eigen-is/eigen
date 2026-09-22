import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CALENDAR_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'calendar',
    currentVersion: 2,
    schema,
    // A calendar's bytes live here now, so an acknowledged PUT must survive a power loss.
    synchronous: 'FULL',
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
            // Only `calendars` and `shared_calendars` carry rows no blob holds — a calendar's name, colors and
            // share grants, the last of which other Homes point at. Everything else is dropped and rewritten.
            version: 2,
            up: (db) =>
                db.exec(`
                DROP TABLE IF EXISTS pending_writes;
                DROP TABLE IF EXISTS resource_tombstones;
                DROP TABLE IF EXISTS events;
                DROP TABLE IF EXISTS event_tombstones;
                DROP TABLE IF EXISTS resources;

                CREATE TABLE calendars_v2 (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    isDefault INTEGER NOT NULL DEFAULT 0,
                    visible INTEGER NOT NULL DEFAULT 1,
                    ctag INTEGER NOT NULL DEFAULT 0,
                    syncGen INTEGER NOT NULL DEFAULT 1,
                    shares TEXT,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
                );
                -- The clock seeds the carried generation, so every token a client holds from before is refused.
                INSERT INTO calendars_v2 (id, name, color, isDefault, visible, ctag, syncGen, shares, createdAt, updatedAt)
                    SELECT id, name, color, isDefault, visible, ctag, unixepoch(), shares,
                           COALESCE(createdAt, unixepoch()), COALESCE(updatedAt, unixepoch())
                    FROM calendars;
                DROP TABLE calendars;
                ALTER TABLE calendars_v2 RENAME TO calendars;

                CREATE TABLE shared_calendars_v2 (
                    id TEXT PRIMARY KEY,
                    ownerUserId TEXT NOT NULL,
                    calendarId TEXT NOT NULL,
                    calendarName TEXT NOT NULL,
                    calendarColor TEXT NOT NULL,
                    permission TEXT NOT NULL,
                    color TEXT,
                    visible INTEGER NOT NULL DEFAULT 1,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
                );
                INSERT INTO shared_calendars_v2
                    SELECT id, ownerUserId, calendarId, calendarName, calendarColor, permission, color, visible,
                           COALESCE(createdAt, unixepoch()), COALESCE(updatedAt, unixepoch())
                    FROM shared_calendars;
                DROP TABLE shared_calendars;
                ALTER TABLE shared_calendars_v2 RENAME TO shared_calendars;

                CREATE TABLE resources (
                    id TEXT PRIMARY KEY,
                    calendarId TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    ics BLOB NOT NULL,
                    etag TEXT NOT NULL,
                    resourceCtag INTEGER NOT NULL,
                    hasUnindexedRecurrence INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (calendarId) REFERENCES calendars(id) ON DELETE CASCADE
                );

                CREATE TABLE events (
                    id TEXT PRIMARY KEY,
                    resourceId TEXT NOT NULL,
                    calendarId TEXT NOT NULL,
                    uid TEXT NOT NULL,
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
                    data TEXT,
                    organizerEventId TEXT,
                    organizerUserId TEXT,
                    sequence INTEGER NOT NULL DEFAULT 0,
                    createByUserId TEXT,
                    createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    updatedAt INTEGER NOT NULL DEFAULT (unixepoch()),
                    FOREIGN KEY (resourceId) REFERENCES resources(id) ON DELETE CASCADE,
                    FOREIGN KEY (calendarId) REFERENCES calendars(id) ON DELETE CASCADE
                );

                CREATE TABLE resource_tombstones (
                    calendarId TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    deletedAtCtag INTEGER NOT NULL,
                    PRIMARY KEY (calendarId, uri)
                );

                CREATE INDEX idx_shared_calendars_ownerUserId ON shared_calendars(ownerUserId);
                CREATE UNIQUE INDEX idx_resources_calendar_uri ON resources(calendarId, uri);
                CREATE UNIQUE INDEX idx_resources_calendar_uid ON resources(calendarId, uid);
                CREATE INDEX idx_resources_uid ON resources(uid);
                CREATE INDEX idx_resources_calendar_ctag ON resources(calendarId, resourceCtag);
                CREATE INDEX idx_events_calendar_start ON events(calendarId, startTime);
                CREATE INDEX idx_events_calendar_end ON events(calendarId, endTime);
                CREATE INDEX idx_events_parent ON events(parentEventId);
                CREATE INDEX idx_events_linked ON events(organizerEventId, organizerUserId);
                CREATE INDEX idx_events_resource ON events(resourceId);
                CREATE INDEX idx_events_uid_calendar ON events(calendarId, uid);
                CREATE INDEX idx_events_uid ON events(uid);
                CREATE INDEX idx_resource_tombstones_cal_ctag ON resource_tombstones(calendarId, deletedAtCtag);
            `),
        },
    ],
};
