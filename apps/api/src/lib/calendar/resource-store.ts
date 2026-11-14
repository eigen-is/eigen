// The calendar half of the store of iCalendar files. It checks the names clients choose, limits the size of a file,
// and turns a file into the rows that search and listing read, so that the file stays the only source of truth.
// Callers such as the CalDAV store and the event edits prepare a file here, and Calendar writes it.

import type { CalendarItem } from '@workspace/lib/types/calendar';
import { sql } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { PATHS } from '../config/paths';
import type { Tx as DatabaseTx } from '../core';
import { computeResourceEtag, readBlobTableSize, sanitizeResourceUri } from '../core';
import type { LocalFilesystem } from '../core/local-filesystem';
import { projectResource, serializeResource } from '../ical';
import { uidOf } from '../ical/ical-parse';
import * as schema from './schema';

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
    return readBlobTableSize(homeFs.absolutePath(PATHS.CALENDAR.DB), 'resources', 'ics');
}

// ctag advances on each change, syncGen rotates on a recreated calendar so stale sync tokens are refused.
export type CalendarCollection = CalendarItem & { syncGen: number };

// The columns one projected VEVENT or exclusion fills.
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
    const resourceId = existingId ?? crypto.randomUUID();
    const text = serializeResource(resource);
    const bytes = Buffer.from(new TextEncoder().encode(text));
    const projected = projectResource(resource);
    const now = new Date();
    // Row ids come from the file's `X-EIGEN-EVENT-ID` lines, and one stored id belongs to one row.
    const claimed = new Set<string>();
    const identified = projected.events.map((event) => {
        const id = event.eventId && !claimed.has(event.eventId) ? event.eventId : crypto.randomUUID();
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
        organizerUserId: event.data?.organizer?.userId ?? null,
        sequence: event.sequence,
        createByUserId: event.createByUserId,
        createdAt: event.createdAt ?? now,
        updatedAt: event.updatedAt ?? now,
    }));

    return {
        id: resourceId,
        uid: uidOf(resource.getAllSubcomponents('vevent')[0]),
        text,
        bytes,
        etag: computeResourceEtag(bytes),
        rows,
        hasUnindexedRecurrence: projected.hasUnindexedRecurrence,
        skipped: projected.skipped,
        duplicateMaster,
    };
}
