import { randomUUID } from 'node:crypto';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { and, eq, inArray } from 'drizzle-orm';
import ICAL from 'ical.js';
import {
    ApiError,
    decodeUtf8Strict,
    ICS_IMPORT_MAX_EVENTS,
    NOT_A_CALENDAR_FILE,
    NOT_UTF8_FILE,
    type PutResourceResult,
} from '../core';
import { newVCalendar, PRODID, serializeResource, spliceBlocks } from '../ical';
import { bareName, calAddress, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import * as schema from './schema';

// Export joins the stored resources into one VCALENDAR; import replays one into the PUT seam a device sync takes (docs/CALENDAR.md § iCalendar import / export).

// A VTIMEZONE is copied into every series that names it, so an upload well inside its own ceiling can ask for many times its size in stored bytes.
const ICS_IMPORT_MAX_WRITTEN_BYTES = 8 * ICS_MAX_BYTES;

// A `.ics` may be a stream of several VCALENDAR objects (RFC 5545 §3.4), which ICAL.parse answers with an array of jCal arrays.
function parseCalendarStream(text: string): ICAL.Component[] {
    const parsed = ICAL.parse(text);
    if (!Array.isArray(parsed[0])) return [new ICAL.Component(parsed)];
    const roots: ICAL.Component[] = [];
    for (const root of parsed) roots.push(new ICAL.Component(root));
    return roots;
}

// A zone can hang on any property and inside a subcomponent — a VALARM's absolute TRIGGER names one too.
function referencedTzids(component: ICAL.Component, into: Set<string>): void {
    for (const prop of component.getAllProperties()) {
        const raw = prop.getParameter('tzid');
        const tzid = Array.isArray(raw) ? raw[0] : raw;
        if (tzid) into.add(String(tzid));
    }
    for (const sub of component.getAllSubcomponents()) referencedTzids(sub, into);
}

// Matched on the bare name: a group prefix ("A.ATTENDEE") names the same property and `removeAllProperties` compares the whole name.
function takeProperties(vevent: ICAL.Component, name: string): ICAL.Property[] {
    const found = vevent.getAllProperties().filter((prop) => bareName(prop.name) === name);
    for (const prop of found) vevent.removeProperty(prop);
    return found;
}

// The organizer stays behind as one inert address for the inbound-REQUEST rule; a VALARM's own ATTENDEE is its recipient, not a guest.
function dropScheduling(vevent: ICAL.Component): string | null {
    takeProperties(vevent, 'attendee');
    const organizer = takeProperties(vevent, 'organizer')[0];
    if (!organizer) return null;
    const address = calAddress(organizer.getFirstValue()).toLowerCase();
    return address.includes('@') ? address : null;
}

// One resource per series, so a crash mid-import is retryable: the series already written are skipped by UID.
export async function importEvents(
    calendar: Calendar,
    calendarId: string,
    bytes: Uint8Array,
): Promise<ImportCountsResult> {
    if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');

    // iCalendar is UTF-8, so another encoding is its own answer rather than "not a calendar".
    const text = decodeUtf8Strict(bytes);
    if (text === null) throw new ApiError(400, NOT_UTF8_FILE);

    // Counted on the text before ical.js builds a tree: a folded line starts with a space, so a line starting with the name is its own VEVENT.
    if ((text.match(/^BEGIN:VEVENT\r?$/gim)?.length ?? 0) > ICS_IMPORT_MAX_EVENTS) {
        throw new ApiError(413, 'Too many events');
    }

    let roots: ICAL.Component[];
    try {
        roots = parseCalendarStream(text);
    } catch (e) {
        if (e instanceof ICAL.parse.ParserError) throw new ApiError(400, NOT_A_CALENDAR_FILE);
        throw e;
    }

    // Grouped by UID first: a file may spell a master in one VCALENDAR object and its overrides in the next.
    const series = new Map<string, { master: ICAL.Component | null; overrides: ICAL.Component[] }>();
    const zones = new Map<string, ICAL.Component>();
    let vevents = 0;
    for (const root of roots) {
        for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
            const tzid = String(vtimezone.getFirstPropertyValue('tzid') ?? '');
            if (tzid && !zones.has(tzid)) zones.set(tzid, vtimezone);
        }
        for (const vevent of root.getAllSubcomponents('vevent')) {
            vevents++;
            if (!uidOf(vevent)) vevent.updatePropertyWithValue('uid', randomUUID());
            const uid = uidOf(vevent);
            const group = series.get(uid) ?? { master: null, overrides: [] };
            series.set(uid, group);
            // A second master of one UID is a malformed series, which the put seam refuses as one.
            if (group.master || vevent.getFirstProperty('recurrence-id')) group.overrides.push(vevent);
            else group.master = vevent;
        }
    }

    // Every VEVENT is a row: one master with 37 000 RECURRENCE-IDs is the write volume of 37 000 masters.
    if (vevents > ICS_IMPORT_MAX_EVENTS) throw new ApiError(413, 'Too many events');

    const actor = calendar.home.user.id;
    const result: ImportCountsResult = { imported: 0, skipped: 0, failed: 0 };
    let written = 0;
    // One list-level event for the whole file instead of one per series.
    await calendar.withBatchedEvents(async () => {
        for (const group of series.values()) {
            // An override with no master has nothing to attach to, and the file goes on without it.
            if (!group.master) {
                result.failed += group.overrides.length;
                continue;
            }
            const importedOrganizer = dropScheduling(group.master);
            for (const override of group.overrides) dropScheduling(override);

            const tzids = new Set<string>();
            referencedTzids(group.master, tzids);
            for (const override of group.overrides) referencedTzids(override, tzids);

            const resource = newVCalendar();
            for (const tzid of tzids) {
                const vtimezone = zones.get(tzid);
                if (vtimezone) resource.addSubcomponent(vtimezone);
            }
            resource.addSubcomponent(group.master);
            for (const override of group.overrides) resource.addSubcomponent(override);

            // A fresh name every time: a UID is not a safe uri, and If-None-Match: * turns a UID the Home already holds into a skippable conflict.
            const body = serializeResource(resource);
            let put: PutResourceResult;
            try {
                put = await calendar.putResource(calendarId, `${randomUUID()}.ics`, body, {
                    ifMatch: null,
                    ifNoneMatch: '*',
                    actor,
                    import: { organizer: importedOrganizer },
                });
            } catch {
                // One series' write failing is that series' failure; a retry finishes the file.
                result.failed++;
                continue;
            }
            if (put.ok) {
                result.imported++;
                written += Buffer.byteLength(body);
                if (written > ICS_IMPORT_MAX_WRITTEN_BYTES) {
                    throw new ApiError(413, `Import too large after importing ${result.imported} events`);
                }
            } else if (put.error === 'uid-conflict') {
                result.skipped++;
            } else if (put.error === 'quota') {
                throw new ApiError(507, `Storage quota exceeded after importing ${result.imported} events`);
            } else {
                result.failed++;
            }
        }
    });
    return result;
}

// ---- Export ----

// Ordered by the earliest start among the rows asked for, so a reader meets the events in the order a calendar draws them.
function exportedUris(calendar: Calendar, calendarId: string, ids?: string[]): string[] {
    const rows = calendar.db
        .select({ id: schema.events.id, uri: schema.resources.uri, startTime: schema.events.startTime })
        .from(schema.events)
        .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id))
        .where(and(eq(schema.events.calendarId, calendarId), ids ? inArray(schema.events.id, ids) : undefined))
        .all();

    const starts = new Map<string, number>();
    const found = new Set<string>();
    for (const row of rows) {
        const start = row.startTime.getTime();
        starts.set(row.uri, Math.min(starts.get(row.uri) ?? start, start));
        found.add(row.id);
    }
    if (ids?.some((id) => !found.has(id))) throw new ApiError(404, 'Event not found');

    return [...starts.keys()].sort((a, b) => (starts.get(a) ?? 0) - (starts.get(b) ?? 0));
}

// One VCALENDAR, never a concatenation of objects: many readers take only the first object of a stream.
export async function exportEvents(calendar: Calendar, calendarId: string, ids?: string[]): Promise<string> {
    if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');

    const uris = exportedUris(calendar, calendarId, ids);
    const zones = new Map<string, string[]>();
    const events: string[][] = [];
    for (const uri of uris) {
        // Read one resource at a time: the whole calendar's bytes at once is the one query that would not scale.
        const row = calendar.db
            .select({ ics: schema.resources.ics })
            .from(schema.resources)
            .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uri, uri)))
            .get();
        if (row) spliceBlocks(new TextDecoder().decode(row.ics), zones, events);
    }

    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:${PRODID}`,
        ...[...zones.values()].flat(),
        ...events.flat(),
        'END:VCALENDAR',
        '',
    ].join('\r\n');
}
