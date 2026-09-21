import { randomUUID } from 'node:crypto';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import ICAL from 'ical.js';
import {
    ApiError,
    decodeUtf8Strict,
    ICS_IMPORT_MAX_EVENTS,
    ICS_IMPORT_MAX_REMINDERS,
    NOT_A_CALENDAR_FILE,
    NOT_UTF8_FILE,
    type PutResourceResult,
} from '../core';
import { buildResource, parseIcs, serializeResource } from '../ical';
import type { IcsParseResult, ParsedEvent } from '../ical/ical-parse';
import type { Calendar } from './calendar';
import { eventForFile, validateEventInput } from './event-input';
import type { CreateEventArgs } from './types';

// Whole-file iCalendar transfer, one resource per series through the same PUT seam a CalDAV device sync
// takes (docs/CALENDAR.md § Importing an .ics).

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

// An imported event as this Home's own: no organizer, no attendees, a handful of reminders.
function importable(event: ParsedEvent): ParsedEvent {
    const reminders = event.data?.reminders?.slice(0, ICS_IMPORT_MAX_REMINDERS);
    return { ...event, data: reminders?.length ? { reminders } : null };
}

function importArgs(event: ParsedEvent, createByUserId: string): CreateEventArgs {
    return {
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        timezone: event.timezone,
        status: event.status,
        sequence: event.sequence,
        data: event.data,
        uid: event.uid,
        createByUserId,
    };
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

    let parsed: IcsParseResult;
    try {
        parsed = parseIcs(text);
    } catch (e) {
        if (e instanceof ICAL.parse.ParserError) throw new ApiError(400, NOT_A_CALENDAR_FILE);
        throw e;
    }

    // Every VEVENT is a row: one master with 37 000 RECURRENCE-IDs is the write volume of 37 000 masters.
    if (parsed.events.length > ICS_IMPORT_MAX_EVENTS) throw new ApiError(413, 'Too many events');

    // One occurrence is one exception row: a file naming the same RECURRENCE-ID twice keeps the last.
    const masters: ParsedEvent[] = [];
    const overridesByUid = new Map<string, Map<string, ParsedEvent>>();
    for (const event of parsed.events) {
        if (!event.recurrenceDate) {
            masters.push(event);
            continue;
        }
        const series = overridesByUid.get(event.uid);
        if (series) series.set(event.recurrenceDate, event);
        else overridesByUid.set(event.uid, new Map([[event.recurrenceDate, event]]));
    }

    // A VEVENT the parser could not read, and an override with no master to attach to, are counted as failures.
    const masterUids = new Set(masters.map((event) => event.uid));
    let unwritable = parsed.skipped;
    for (const [uid, overrides] of overridesByUid) {
        if (!masterUids.has(uid)) unwritable += overrides.size;
    }

    const createByUserId = calendar.home.user.id;
    const result: ImportCountsResult = { imported: 0, skipped: 0, failed: unwritable };
    // One list-level event for the whole file instead of one per series.
    await calendar.withBatchedEvents(async () => {
        for (const parsedMaster of masters) {
            const master = importable(parsedMaster);
            if (!isImportableUid(master.uid)) {
                result.failed++;
                continue;
            }
            // A UID the Home already holds skips like a re-import, which is what makes a partial import retryable.
            if (await calendar.holdsUid(master.uid)) {
                result.skipped++;
                continue;
            }

            let body: string;
            try {
                const now = new Date();
                const masterId = randomUUID();
                const args = importArgs(master, createByUserId);
                const events = [eventForFile({ id: masterId, calendarId, uid: master.uid, input: args, now })];
                for (const override of overridesByUid.get(master.uid)?.values() ?? []) {
                    const overrideArgs = importArgs(importable(override), createByUserId);
                    events.push(
                        eventForFile({
                            id: randomUUID(),
                            calendarId,
                            uid: master.uid,
                            // The master's zone when the override names none, or it keys a different day (audit #24).
                            input: {
                                ...overrideArgs,
                                rrule: null,
                                timezone: overrideArgs.timezone ?? args.timezone,
                                parentEventId: masterId,
                                recurrenceDate: override.recurrenceDate,
                            },
                            now,
                        }),
                    );
                }
                // The series is one resource: a member the domain refuses takes the series with it.
                for (const event of events) validateEventInput(event);
                body = serializeResource(buildResource(events));
            } catch {
                result.failed++;
                continue;
            }

            // A fresh name every time: a UID is not a safe filename, and If-None-Match: * keeps the write a create.
            let put: PutResourceResult;
            try {
                put = await calendar.putResource(calendarId, `${randomUUID()}.ics`, body, {
                    ifMatch: null,
                    ifNoneMatch: '*',
                    actor: createByUserId,
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
