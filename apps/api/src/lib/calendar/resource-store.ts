import type { CalendarItem } from '@workspace/lib/types/calendar';
import { and, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import {
    type LocalFilesystem,
    PATHS,
    type ResourceScan,
    sanitizeResourceUri,
    statResourceDir,
    uriKeyOf,
} from '../core';
import * as schema from './schema';

// The calendar-shaped half of `core/indexed-file-store.ts`; the protocol layers import from here, never the reverse.

const ICS_SUFFIX = '.ics';

// CalDAV bounds a PUT body against this before buffering and advertises it as C:max-resource-size.
export const EVENT_MAX_BYTES = 5_242_880;

export function calendarDir(calendarId: string): string {
    return `${PATHS.CALENDAR.CALENDARS}/${calendarId}`;
}

export function resourcePath(calendarId: string, uri: string): string {
    return `${calendarDir(calendarId)}/${uri}`;
}

// A client-chosen calendar id is a directory name and goes raw into an href, so it takes the shared segment rule over the NFC form.
export function sanitizeCalendarId(raw: string): string | null {
    return sanitizeResourceUri(raw, '');
}

export function sanitizeEventUri(raw: string): string | null {
    return sanitizeResourceUri(raw, ICS_SUFFIX);
}

export function statCalendarDir(storage: LocalFilesystem, calendarId: string): Promise<ResourceScan> {
    return statResourceDir(storage, calendarDir(calendarId), ICS_SUFFIX);
}

// The calendar bytes of a Home nobody has booted: the `.ics` of every directory a calendar row can own, never the `.`-prefixed staging.
export async function readCalendarTotalSize(homeFs: LocalFilesystem): Promise<number> {
    const root = `${PATHS.CALENDAR.ROOT}/${PATHS.CALENDAR.CALENDARS}`;
    if (!(await homeFs.dirExists(root))) return 0;
    let total = 0;
    for (const entry of await homeFs.readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || sanitizeCalendarId(entry.name) !== entry.name) continue;
        const scan = await statResourceDir(homeFs, `${root}/${entry.name}`, ICS_SUFFIX);
        for (const file of scan.files.values()) total += file.size;
    }
    return total;
}

// The gate key of one resource. Neither segment holds a `/`, so the pair round-trips through one string.
export function gateKey(calendarId: string, uri: string): string {
    return `${calendarId}/${uri}`;
}

export function parseGateKey(key: string): { calendarId: string; uri: string } {
    const slash = key.indexOf('/');
    return { calendarId: key.slice(0, slash), uri: key.slice(slash + 1) };
}

// ctag advances on each change, syncGen rotates on an index rebuild so stale sync tokens are refused.
export type CalendarCollection = CalendarItem & { syncGen: number };

// The columns a (re)index computes for one projected VEVENT or exclusion.
export type EventRowInput = Omit<typeof schema.events.$inferInsert, 'createdAt' | 'updatedAt'> & {
    createdAt: Date;
    updatedAt: Date;
};

// The transaction handle drizzle hands a `db.transaction(cb)` callback.
export type Tx = Parameters<Parameters<BunSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

// Runs inside the transaction that bumped the ctag, so a write, a drain and a reconcile all leave one shape behind.
export function indexResource(
    tx: Tx,
    resource: Omit<typeof schema.resources.$inferInsert, 'uriKey'>,
    rows: EventRowInput[],
): void {
    const row = {
        uri: resource.uri,
        uriKey: uriKeyOf(resource.uri),
        uid: resource.uid,
        etag: resource.etag,
        mtime: resource.mtime,
        size: resource.size,
        resourceCtag: resource.resourceCtag,
        hasUnindexedRecurrence: resource.hasUnindexedRecurrence,
    };
    tx.insert(schema.resources)
        .values({ id: resource.id, calendarId: resource.calendarId, ...row })
        .onConflictDoUpdate({ target: schema.resources.id, set: row })
        .run();
    tx.delete(schema.events).where(eq(schema.events.resourceId, resource.id)).run();
    for (const event of rows) tx.insert(schema.events).values(event).run();
    // So no href is ever both a 200 and a 404 in one sync response.
    tx.delete(schema.resourceTombstones)
        .where(
            and(
                eq(schema.resourceTombstones.calendarId, resource.calendarId),
                eq(schema.resourceTombstones.uriKey, row.uriKey),
            ),
        )
        .run();
}

// A settled write intent: the index owes that file nothing any more.
export function clearPendingWrite(db: Tx | BunSQLiteDatabase<typeof schema>, calendarId: string, uri: string): void {
    db.delete(schema.pendingWrites)
        .where(and(eq(schema.pendingWrites.calendarId, calendarId), eq(schema.pendingWrites.uri, uri)))
        .run();
}
