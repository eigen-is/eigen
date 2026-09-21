import { randomUUID } from 'node:crypto';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq } from 'drizzle-orm';
import ICAL from 'ical.js';
import {
    ApiError,
    decodeUtf8Strict,
    ICS_IMPORT_MAX_EVENTS,
    NOT_A_CALENDAR_FILE,
    NOT_UTF8_FILE,
    type PutResourceResult,
    readResourceFile,
} from '../core';
import { newVCalendar, PRODID, serializeResource } from '../ical';
import { calAddress, isEigenName, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import { holdsUid } from './events';
import { resourcePath } from './resource-store';
import * as schema from './schema';

// Whole-file iCalendar transfer over the Calendar facade: export joins the stored files into one
// VCALENDAR, import replays one into the same PUT seam a CalDAV device sync takes (docs/CALENDAR.md
// § Importing an .ics). The file is the truth on both sides — the import moves components, so every line
// the author wrote lands as written and scheduling is the only thing taken out of it, and the export
// hands back the stored bytes minus the lines Eigen owns.

// A UID travels into etags and sync deltas, so an unprintable or endless one is refused rather than stored.
const MAX_UID_LENGTH = 255;
function isImportableUid(uid: string): boolean {
    if (!uid || uid.length > MAX_UID_LENGTH) return false;
    for (let index = 0; index < uid.length; index++) {
        const code = uid.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

// A `.ics` may be a stream of several VCALENDAR objects (RFC 5545 §3.4), which ICAL.parse answers with an
// array of jCal arrays rather than one.
function parseCalendarStream(text: string): ICAL.Component[] {
    const parsed = ICAL.parse(text);
    if (!Array.isArray(parsed[0])) return [new ICAL.Component(parsed)];
    const roots: ICAL.Component[] = [];
    for (const root of parsed) roots.push(new ICAL.Component(root));
    return roots;
}

// The TZIDs a VEVENT names, whether on its DTSTART or on any other property a client hung a zone on.
function referencedTzids(vevent: ICAL.Component, into: Set<string>): void {
    for (const prop of vevent.getAllProperties()) {
        const raw = prop.getParameter('tzid');
        const tzid = Array.isArray(raw) ? raw[0] : raw;
        if (tzid) into.add(String(tzid));
    }
}

// Scheduling is what an imported event loses, and nothing else: the guest list goes, and the organizer
// stays behind as one inert address for the inbound-REQUEST rule to match a verified sender against.
// A VALARM keeps its own ATTENDEE — that is the alarm's recipient, not a guest.
function dropScheduling(vevent: ICAL.Component): string | null {
    vevent.removeAllProperties('attendee');
    const organizer = vevent.getFirstProperty('organizer');
    if (!organizer) return null;
    const address = calAddress(organizer.getFirstValue()).toLowerCase();
    vevent.removeAllProperties('organizer');
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

    // Counted on the text before ical.js builds a tree per VEVENT. A folded line starts with a space, so a
    // line that starts with the property name is a VEVENT of its own.
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

    // One series is one resource, so the whole stream is grouped by UID first — a file may spell a master
    // in one VCALENDAR object and its overrides in the next. A VEVENT naming no UID gets a minted one.
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
    // One list-level event for the whole file instead of one per series.
    await calendar.withBatchedEvents(async () => {
        for (const [uid, group] of series) {
            // An override with no master has nothing to attach to, and the file goes on without it.
            if (!group.master) {
                result.failed += group.overrides.length;
                continue;
            }
            if (!isImportableUid(uid)) {
                result.failed++;
                continue;
            }
            // A UID the Home already holds skips like a re-import, which is what makes a partial import retryable.
            if (await holdsUid(calendar, uid)) {
                result.skipped++;
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

            // A fresh name every time: a UID is not a safe filename, and If-None-Match: * keeps the write a create.
            let put: PutResourceResult;
            try {
                put = await calendar.putResource(calendarId, `${randomUUID()}.ics`, serializeResource(resource), {
                    ifMatch: null,
                    ifNoneMatch: '*',
                    actor,
                    importedOrganizer,
                });
            } catch {
                // One series' write failing is that series' failure; a retry finishes the file.
                result.failed++;
                continue;
            }
            if (put.ok) {
                result.imported++;
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

// One logical content line: the property name it opens with, and the physical lines it was folded into.
type ContentLine = { name: string; text: string };

function contentLines(ics: string): ContentLine[] {
    const lines: ContentLine[] = [];
    for (const physical of ics.split('\n')) {
        const text = physical.endsWith('\r') ? physical.slice(0, -1) : physical;
        if (!text) continue;
        // RFC 5545 §3.1: a line beginning with a space or a tab continues the one before it.
        if ((text[0] === ' ' || text[0] === '\t') && lines.length) {
            lines[lines.length - 1].text += `\r\n${text}`;
            continue;
        }
        const end = text.search(/[;:]/);
        lines.push({ name: (end === -1 ? text : text.slice(0, end)).toLowerCase(), text });
    }
    return lines;
}

// The VTIMEZONE and VEVENT blocks of one stored resource, with every line Eigen owns dropped. A splice
// rather than a parse → toString: ical.js rewrites parameter quoting and order on every line it re-emits
// (a `VALUE=URI` folded into the jCal type, a quoted parameter re-escaped RFC 6868-style), and a file the
// store only indexed was never Eigen's to rewrite. Only Eigen's own lines carry an Eigen parameter, so
// dropping those lines whole is the strip `stripEigenStamps` performs.
function spliceBlocks(ics: string, zones: Map<string, string[]>, events: string[][]): void {
    let block: string[] | null = null;
    let depth = 0;
    for (const line of contentLines(ics)) {
        if (!block) {
            if (line.text === 'BEGIN:VTIMEZONE' || line.text === 'BEGIN:VEVENT') {
                block = [line.text];
                depth = 1;
            }
            continue;
        }
        if (line.text.startsWith('BEGIN:')) depth++;
        else if (line.text.startsWith('END:')) depth--;
        if (!isEigenName(line.name)) block.push(line.text);
        if (depth > 0) continue;

        if (block[0] === 'BEGIN:VEVENT') {
            events.push(block);
        } else {
            // The first definition of a TZID wins: two resources naming one zone carry it once.
            const tzid = block.find((text) => text.startsWith('TZID:'))?.slice(5) ?? '';
            if (!zones.has(tzid)) zones.set(tzid, block);
        }
        block = null;
    }
}

// The resource uris of `ids` — an exclusion or an override names the series it belongs to — or every
// resource of the calendar. Ordered by the earliest start each file holds, so a reader meets the events
// in the order a calendar draws them.
function exportedUris(calendar: Calendar, calendarId: string, ids?: string[]): string[] {
    const rows = calendar.db
        .select({ id: schema.events.id, uri: schema.resources.uri, startTime: schema.events.startTime })
        .from(schema.events)
        .innerJoin(schema.resources, eq(schema.events.resourceId, schema.resources.id))
        .where(eq(schema.events.calendarId, calendarId))
        .all();

    const starts = new Map<string, number>();
    for (const row of rows) {
        const start = row.startTime.getTime();
        starts.set(row.uri, Math.min(starts.get(row.uri) ?? start, start));
    }

    let uris = [...starts.keys()];
    if (ids) {
        const uriById = new Map(rows.map((row) => [row.id, row.uri]));
        const wanted = new Set<string>();
        for (const id of ids) {
            const uri = uriById.get(id);
            if (!uri) throw new ApiError(404, 'Event not found');
            wanted.add(uri);
        }
        uris = uris.filter((uri) => wanted.has(uri));
    }
    return uris.sort((a, b) => (starts.get(a) ?? 0) - (starts.get(b) ?? 0));
}

// One VCALENDAR, never a concatenation of objects: many readers take only the first object of a stream.
export async function exportEvents(calendar: Calendar, calendarId: string, ids?: string[]): Promise<string> {
    if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');
    await calendar.gate.ensureDrained();

    const uris = exportedUris(calendar, calendarId, ids);
    const zones = new Map<string, string[]>();
    const events: string[][] = [];
    for (const uri of uris) {
        const bytes = await readResourceFile(calendar.storage, resourcePath(calendarId, uri));
        // A row whose file is gone is a torn pair the next drain repairs; it is nothing to export.
        if (bytes) spliceBlocks(new TextDecoder().decode(bytes), zones, events);
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
