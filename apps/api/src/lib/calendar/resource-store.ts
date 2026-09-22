import { randomUUID } from 'node:crypto';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { and, eq, sql } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { computeResourceEtag, type Tx as DatabaseTx, PATHS, readBlobTableSize, sanitizeResourceUri } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import { projectResource, serializeResource } from '../ical';
import { uidOf } from '../ical/ical-parse';
import { CALENDAR_DB_CONFIG } from './db-config';
import * as schema from './schema';

// The calendar-shaped half of the store over `core/blob-store.ts`. See docs/CALENDAR.md § Storage model.

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

// `homeFs` is rooted at the home folder, not at the calendar root.
export async function readCalendarTotalSize(homeFs: LocalFilesystem): Promise<number> {
    return readBlobTableSize(
        homeFs.absolutePath(PATHS.CALENDAR.DB),
        'resources',
        'ics',
        CALENDAR_DB_CONFIG.currentVersion,
    );
}

// ctag advances on each change, syncGen rotates on a recreated calendar so stale sync tokens are refused.
export type CalendarCollection = CalendarItem & { syncGen: number };

// The columns a (re)index computes for one projected VEVENT or exclusion.
export type EventRowInput = Omit<typeof schema.events.$inferInsert, 'createdAt' | 'updatedAt'> & {
    createdAt: Date;
    updatedAt: Date;
};

// What purgeResource needs of the row it removes: its calendar and its name for the tombstone, its etag for
// the precondition the DAV delete evaluates.
export const PURGED_RESOURCE = {
    id: schema.resources.id,
    calendarId: schema.resources.calendarId,
    uri: schema.resources.uri,
    etag: schema.resources.etag,
};
export type PurgedResource = { [K in keyof typeof PURGED_RESOURCE]: (typeof schema.resources.$inferSelect)[K] };

// What one commit writes: the resource's own columns plus every event row its bytes project to.
export type ResourceCommit = {
    id: string;
    calendarId: string;
    uri: string;
    uid: string;
    ics: Buffer;
    etag: string;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
};

export function uidOfResource(resource: ICAL.Component): string {
    return uidOf(resource.getAllSubcomponents('vevent')[0]);
}

// The rows a file projects to, ids from its `X-EIGEN-EVENT-ID` lines: one stored id belongs to one row.
export function projectRows(
    calendarId: string,
    resourceId: string,
    resource: ICAL.Component,
): { rows: EventRowInput[]; hasUnindexedRecurrence: boolean; skipped: number; duplicateMaster: boolean } {
    const projected = projectResource(resource);
    const now = new Date();
    const claimed = new Set<string>();
    const identified = projected.events.map((event) => {
        const id = event.eventId && !claimed.has(event.eventId) ? event.eventId : randomUUID();
        claimed.add(id);
        return { event, id };
    });

    // A master leads its overrides whatever order the file lists them in; a second master is malformed, the first still leads.
    const masterIdByUid = new Map<string, string>();
    let duplicateMaster = false;
    for (const { event, id } of identified) {
        if (event.recurrenceDate !== null) continue;
        if (masterIdByUid.has(event.uid)) duplicateMaster = true;
        else masterIdByUid.set(event.uid, id);
    }

    const rows = identified.map(({ event, id }) => ({
        id,
        resourceId,
        calendarId,
        uid: event.uid,
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        timezone: event.timezone,
        parentEventId: event.recurrenceDate === null ? null : (masterIdByUid.get(event.uid) ?? null),
        recurrenceDate: event.recurrenceDate,
        status: event.status,
        data: event.data,
        organizerEventId: event.data?.organizerEventId ?? null,
        organizerUserId: event.data?.organizer?.userId || null,
        sequence: event.sequence,
        createByUserId: event.createByUserId,
        createdAt: event.createdAt ?? now,
        updatedAt: event.updatedAt ?? now,
    }));

    return {
        rows,
        hasUnindexedRecurrence: projected.hasUnindexedRecurrence,
        skipped: projected.skipped,
        duplicateMaster,
    };
}

export type PreparedResource = {
    id: string;
    uid: string;
    text: string;
    bytes: Buffer;
    etag: string;
    rows: EventRowInput[];
    hasUnindexedRecurrence: boolean;
    skipped: number;
    duplicateMaster: boolean;
};

// The pure half of a resource write: a component in, the bytes it serializes to and the rows they project
// to out. `existingId` is the id of the resource this one replaces, so a rewrite keeps its row.
export function prepareResource(
    calendarId: string,
    resource: ICAL.Component,
    existingId: string | null,
): PreparedResource {
    const id = existingId ?? randomUUID();
    const text = serializeResource(resource);
    const bytes = Buffer.from(new TextEncoder().encode(text));
    return {
        id,
        uid: uidOfResource(resource),
        text,
        bytes,
        etag: computeResourceEtag(bytes),
        ...projectRows(calendarId, id, resource),
    };
}

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
    reindexEvents(tx, resource.id, rows);
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

// The projected rows are replaced wholesale, so an event a rewrite no longer carries leaves no row behind.
export function reindexEvents(tx: Tx, resourceId: string, rows: EventRowInput[]): void {
    tx.delete(schema.events).where(eq(schema.events.resourceId, resourceId)).run();
    for (const event of rows) tx.insert(schema.events).values(event).run();
}
