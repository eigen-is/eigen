import type { DatabaseConfig } from '../core/managed-database';
import * as schema from './schema';

export const CALENDAR_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'calendar',
    currentVersion: 2,
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
            // Files-as-truth refit: events live in `calendars/<calendarId>/<uri>` and this database becomes
            // the index over them. The v1 event rows are DROPPED, not migrated — init re-derives them from
            // the files, and a v1 home has none (docs/CALENDAR.md § Storage). `calendars` and
            // `shared_calendars` are authoritative, so they are reshaped in place rather than dropped.
            version: 2,
            up: (db) =>
                db.exec(`
                DROP TABLE IF EXISTS events;
                DROP TABLE IF EXISTS event_tombstones;

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
                INSERT INTO calendars_v2 (id, name, color, isDefault, visible, ctag, shares, createdAt, updatedAt)
                    SELECT id, name, color, isDefault, visible, ctag, shares,
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
                CREATE INDEX IF NOT EXISTS idx_shared_calendars_ownerUserId ON shared_calendars(ownerUserId);

                CREATE TABLE IF NOT EXISTS resources (
                    id TEXT PRIMARY KEY,
                    calendarId TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    uriKey TEXT NOT NULL,
                    uid TEXT NOT NULL,
                    etag TEXT NOT NULL,
                    mtime INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    resourceCtag INTEGER NOT NULL,
                    hasUnindexedRecurrence INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (calendarId) REFERENCES calendars(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS events (
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

                CREATE TABLE IF NOT EXISTS resource_tombstones (
                    calendarId TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    uriKey TEXT NOT NULL,
                    deletedAtCtag INTEGER NOT NULL,
                    PRIMARY KEY (calendarId, uri)
                );

                CREATE TABLE IF NOT EXISTS pending_writes (
                    calendarId TEXT NOT NULL,
                    uri TEXT NOT NULL,
                    PRIMARY KEY (calendarId, uri),
                    FOREIGN KEY (calendarId) REFERENCES calendars(id) ON DELETE CASCADE
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_calendar_key ON resources(calendarId, uriKey);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_calendar_uid ON resources(calendarId, uid);
                CREATE INDEX IF NOT EXISTS idx_resources_uid ON resources(uid);
                CREATE INDEX IF NOT EXISTS idx_resources_calendar_ctag ON resources(calendarId, resourceCtag);
                CREATE INDEX IF NOT EXISTS idx_events_calendar_start ON events(calendarId, startTime);
                CREATE INDEX IF NOT EXISTS idx_events_calendar_end ON events(calendarId, endTime);
                CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parentEventId);
                CREATE INDEX IF NOT EXISTS idx_events_linked ON events(organizerEventId, organizerUserId);
                CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resourceId);
                CREATE INDEX IF NOT EXISTS idx_events_uid_calendar ON events(calendarId, uid);
                CREATE INDEX IF NOT EXISTS idx_events_uid ON events(uid);
                CREATE INDEX IF NOT EXISTS idx_resource_tombstones_cal_ctag ON resource_tombstones(calendarId, deletedAtCtag);
                CREATE INDEX IF NOT EXISTS idx_resource_tombstones_cal_key ON resource_tombstones(calendarId, uriKey);
            `),
        },
    ],
};
