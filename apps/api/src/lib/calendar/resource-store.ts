import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { and, eq, sql } from 'drizzle-orm';
import { type Tx as DatabaseTx, PATHS, sanitizeResourceUri } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import * as schema from './schema';

// The calendar-shaped half of the store over `core/blob-store.ts`. See docs/CALENDAR.md § Storage model.

// One home's transaction handle; every seam that writes inside the caller's transaction takes it.
export type Tx = DatabaseTx<typeof schema>;

const ICS_SUFFIX = '.ics';

// CalDAV bounds a PUT body against this before buffering and advertises it as C:max-resource-size.
export const EVENT_MAX_BYTES = 5_242_880;

// A resource's stored size is the length of its bytes; no column beside them can drift from them.
export const resourceBytes = sql<number>`length(${schema.resources.ics})`;

// A client-chosen calendar id goes raw into an href, so it takes the shared segment rule over the NFC form.
export function sanitizeCalendarId(raw: string): string | null {
    return sanitizeResourceUri(raw, '');
}

export function sanitizeEventUri(raw: string): string | null {
    return sanitizeResourceUri(raw, ICS_SUFFIX);
}

// Sizes Calendar for a Home nobody booted; `homeFs` is rooted at the home folder, not at the calendar root.
// Read-write on purpose, following mount/helpers.ts readMountTotalSize: a read-only open of a WAL database
// whose owner is not holding it open fails outright.
export async function readCalendarTotalSize(homeFs: LocalFilesystem): Promise<number> {
    const dbPath = homeFs.absolutePath(PATHS.CALENDAR.DB);
    if (!fs.existsSync(dbPath)) return 0;
    const db = new Database(dbPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA busy_timeout = 5000;');
        const row = db
            .query<{ events: number }, []>('SELECT COALESCE(SUM(length(ics)), 0) AS events FROM resources')
            .get();
        return row?.events ?? 0;
    } finally {
        db.close();
    }
}

// ctag advances on each change, syncGen rotates on a recreated calendar so stale sync tokens are refused.
export type CalendarCollection = CalendarItem & { syncGen: number };

// The columns a (re)index computes for one projected VEVENT or exclusion.
export type EventRowInput = Omit<typeof schema.events.$inferInsert, 'createdAt' | 'updatedAt'> & {
    createdAt: Date;
    updatedAt: Date;
};

// Runs inside the transaction that bumped the ctag, so a write and a rebuild leave one shape behind.
export function indexResource(tx: Tx, resource: typeof schema.resources.$inferInsert, rows: EventRowInput[]): void {
    const row = {
        uri: resource.uri,
        uid: resource.uid,
        ics: resource.ics,
        etag: resource.etag,
        resourceCtag: resource.resourceCtag,
        hasUnindexedRecurrence: resource.hasUnindexedRecurrence,
    };
    tx.insert(schema.resources)
        .values({ id: resource.id, calendarId: resource.calendarId, ...row })
        .onConflictDoUpdate({ target: schema.resources.id, set: row })
        .run();
    tx.delete(schema.events).where(eq(schema.events.resourceId, resource.id)).run();
    for (const event of rows) tx.insert(schema.events).values(event).run();
    // A resource at this uri is alive, so one written over a deleted name drops its stale removal.
    tx.delete(schema.resourceTombstones)
        .where(
            and(
                eq(schema.resourceTombstones.calendarId, resource.calendarId),
                eq(schema.resourceTombstones.uri, resource.uri),
            ),
        )
        .run();
}
