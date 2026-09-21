import { randomUUID } from 'node:crypto';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import ICAL from 'ical.js';
import {
    ApiError,
    decodeUtf8Strict,
    ICS_IMPORT_MAX_EVENTS,
    NOT_A_CALENDAR_FILE,
    NOT_UTF8_FILE,
    type PutResourceResult,
} from '../core';
import { newVCalendar, serializeResource } from '../ical';
import { calAddress, uidOf } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import { holdsUid } from './events';

// Whole-file iCalendar transfer, one resource per series through the same PUT seam a CalDAV device sync
// takes (docs/CALENDAR.md § Importing an .ics). The file is the truth, so the import moves components:
// every line the author wrote lands as written, and scheduling is the only thing taken out of it.

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
            if (vevent.getFirstProperty('recurrence-id')) group.overrides.push(vevent);
            else if (group.master)
                group.overrides.push(vevent); // two masters: the seam refuses the series
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
