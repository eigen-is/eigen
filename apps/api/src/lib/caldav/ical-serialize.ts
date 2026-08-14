import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { computeOccurrenceTimes, storedRecurrenceKey, utcToLocal } from '../calendar/recurrence';
import { normalizeTimezone } from '../calendar/timezone';
import { buildVTimezone } from './vtimezone';

const pad = (n: number) => n.toString().padStart(2, '0');

// RFC 5545 §3.3.11 — escape TEXT values
function escapeICalText(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').replace(/\r/g, '');
}

// Escape a value for use inside a double-quoted PARAM-VALUE (e.g. CN="...").
// Double quotes would break out of the parameter; CRLF could inject properties.
function escapeICalParamValue(s: string): string {
    return s.replace(/"/g, "'").replace(/[\r\n]/g, '');
}

// RFC 5545 §3.1 / RFC 2425 §5.8.1 — fold lines longer than 75 octets with CRLF + single space.
// Shared with the vCard serializer (carddav/vcard-ast.ts): the algorithm is identical across both
// directory formats, so it lives here as the one source of truth.
export function foldLine(line: string): string {
    const bytes = new TextEncoder().encode(line);
    if (bytes.length <= 75) return line;

    const parts: string[] = [];
    let offset = 0;
    let first = true;

    while (offset < bytes.length) {
        const limit = first ? 75 : 74; // continuation lines lose 1 octet to the leading space
        first = false;

        // Walk back from limit so we never split a multi-byte character
        let end = Math.min(offset + limit, bytes.length);
        // If the byte at `end` is a UTF-8 continuation byte (10xxxxxx), back up
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
            end--;
        }

        parts.push(new TextDecoder().decode(bytes.slice(offset, end)));
        offset = end;
    }

    return parts.join('\r\n ');
}

function formatDateTimeUTC(d: Date): string {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatDateUTC(d: Date): string {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// Format a Date as local wall-clock time in the given IANA timezone (YYYYMMDDTHHmmSS)
function formatDateTimeInTZ(d: Date, tz: string): string {
    const l = utcToLocal(d, tz);
    return `${l.year}${pad(l.month)}${pad(l.day)}T${pad(l.hour)}${pad(l.minute)}${pad(l.second)}`;
}

function mapAttendeeRole(role: Attendee['role']): string {
    return role === 'optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT';
}

function mapAttendeeStatus(status: Attendee['status']): string {
    switch (status) {
        case 'accepted':
            return 'ACCEPTED';
        case 'declined':
            return 'DECLINED';
        case 'tentative':
            return 'TENTATIVE';
        default:
            return 'NEEDS-ACTION';
    }
}

function buildVEvent(
    event: CalendarEvent,
    options?: { rsvp?: boolean; master?: CalendarEvent; exdates?: CalendarEvent[] },
): string[] {
    const lines: string[] = [];

    const prop = (line: string) => lines.push(foldLine(line));

    // Rows stored before ingestion normalized TZIDs can hold a non-IANA zone; serialize those like
    // no-timezone events (absolute UTC) instead of letting Intl throw and 500 a whole CalDAV collection.
    const tzid = normalizeTimezone(event.timezone);

    prop('BEGIN:VEVENT');
    prop(`UID:${escapeICalText(event.uid)}`);
    prop(`SUMMARY:${escapeICalText(event.title)}`);

    // DTSTART / DTEND
    if (event.allDay) {
        prop(`DTSTART;VALUE=DATE:${formatDateUTC(event.startTime)}`);
        prop(`DTEND;VALUE=DATE:${formatDateUTC(event.endTime)}`);
    } else if (tzid) {
        prop(`DTSTART;TZID=${tzid}:${formatDateTimeInTZ(event.startTime, tzid)}`);
        prop(`DTEND;TZID=${tzid}:${formatDateTimeInTZ(event.endTime, tzid)}`);
    } else {
        prop(`DTSTART:${formatDateTimeUTC(event.startTime)}`);
        prop(`DTEND:${formatDateTimeUTC(event.endTime)}`);
    }

    if (event.description) prop(`DESCRIPTION:${escapeICalText(event.description)}`);
    if (event.location) prop(`LOCATION:${escapeICalText(event.location)}`);

    prop(`STATUS:${event.status.toUpperCase()}`);
    prop(`SEQUENCE:${event.sequence}`);
    prop(`CREATED:${formatDateTimeUTC(event.createdAt)}`);
    prop(`LAST-MODIFIED:${formatDateTimeUTC(event.updatedAt)}`);
    prop(`DTSTAMP:${formatDateTimeUTC(event.updatedAt)}`);

    if (event.rrule) {
        // Eigen's frontend stores RRULE with "RRULE:" prefix; strip it to avoid doubling
        const rruleValue = event.rrule.replace(/^RRULE:/i, '');
        prop(`RRULE:${rruleValue}`);
    }

    // A cancelled exception is a deleted occurrence: emit it as EXDATE in the master's own DTSTART
    // form — the shape every client round-trips — never as a STATUS:CANCELLED override VEVENT,
    // which Thunderbird omits from its next PUT (the full-replace exception prune would then
    // resurrect the deleted occurrence).
    for (const exc of options?.exdates ?? []) {
        const key = exc.recurrenceDate ? storedRecurrenceKey(exc.recurrenceDate) : null;
        if (!key) continue; // an unkeyable cancellation cancels nothing (matches expansion)
        if (event.allDay) {
            prop(`EXDATE;VALUE=DATE:${key.replace(/-/g, '')}`);
        } else {
            const exTime = computeOccurrenceTimes(event, key).startTime;
            if (tzid) {
                prop(`EXDATE;TZID=${tzid}:${formatDateTimeInTZ(exTime, tzid)}`);
            } else {
                prop(`EXDATE:${formatDateTimeUTC(exTime)}`);
            }
        }
    }

    // RECURRENCE-ID names the ORIGINAL occurrence being overridden, in the master's TZID form
    // (RFC 5545). The exception's own startTime may have been moved — echoing it back produces an
    // override that matches no occurrence, so clients render the original slot too (audit #C).
    // The master's tz (not the exception's) decides the form: legacy exception rows hold timezone:null.
    if (event.recurrenceDate) {
        // An unkeyable legacy value falls back to the exception's own startTime (the pre-#C shape:
        // a possibly-orphaned override beats 500ing the whole resource).
        const key = storedRecurrenceKey(event.recurrenceDate);
        if (event.allDay) {
            const compact = key ? key.replace(/-/g, '') : formatDateUTC(event.startTime);
            prop(`RECURRENCE-ID;VALUE=DATE:${compact}`);
        } else {
            const master = options?.master;
            const ridTime = master && key ? computeOccurrenceTimes(master, key).startTime : event.startTime;
            const ridTz = master ? normalizeTimezone(master.timezone) : tzid;
            if (ridTz) {
                prop(`RECURRENCE-ID;TZID=${ridTz}:${formatDateTimeInTZ(ridTime, ridTz)}`);
            } else {
                prop(`RECURRENCE-ID:${formatDateTimeUTC(ridTime)}`);
            }
        }
    }

    // ORGANIZER
    const organizer = event.data?.organizer;
    if (organizer) {
        const cn = organizer.name ? `;CN="${escapeICalParamValue(organizer.name)}"` : '';
        prop(`ORGANIZER${cn}:mailto:${organizer.email}`);
    }

    // ATTENDEE lines — for iMIP, include the organizer as ACCEPTED attendee (RFC 5546)
    const attendees = event.data?.attendees ?? [];
    if (options?.rsvp && organizer && !attendees.some((a) => a.email === organizer.email)) {
        const cn = organizer.name ? `;CN="${escapeICalParamValue(organizer.name)}"` : '';
        prop(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED${cn}:mailto:${organizer.email}`);
    }
    for (const attendee of attendees) {
        const cn = attendee.name ? `;CN="${escapeICalParamValue(attendee.name)}"` : '';
        const rsvp = options?.rsvp ? ';RSVP=TRUE' : '';
        prop(
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${mapAttendeeRole(attendee.role)};PARTSTAT=${mapAttendeeStatus(attendee.status)}${rsvp}${cn}:mailto:${attendee.email}`,
        );
    }

    // VALARM blocks
    for (const reminder of event.data?.reminders ?? []) {
        lines.push('BEGIN:VALARM');
        prop(`TRIGGER:-PT${reminder.minutes}M`);
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:Reminder');
        lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
    return lines;
}

function wrapInVCalendar(eventLines: string[], method?: 'REQUEST' | 'REPLY' | 'CANCEL'): string {
    const header = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eigen//CalDAV//EN'];
    if (method) header.push(`METHOD:${method}`);
    const lines = [...header, ...eventLines, 'END:VCALENDAR'];
    return `${lines.join('\r\n')}\r\n`;
}

// One VTIMEZONE per IANA TZID the events reference (RFC 5545 §3.6.5) — without it, strict parsers
// (including ical.js, i.e. a peer Eigen receiving this via iMIP) read the wall times as floating.
function vtimezoneLines(events: CalendarEvent[]): string[] {
    const tzids = new Set<string>();
    let minYear = Number.POSITIVE_INFINITY;
    let maxYear = Number.NEGATIVE_INFINITY;
    let hasRrule = false;
    for (const event of events) {
        if (event.allDay) continue;
        const tzid = normalizeTimezone(event.timezone);
        if (!tzid) continue;
        tzids.add(tzid);
        minYear = Math.min(minYear, event.startTime.getUTCFullYear());
        maxYear = Math.max(maxYear, event.endTime.getUTCFullYear());
        if (event.rrule) hasRrule = true;
    }
    if (!tzids.size) return [];
    // Open-ended RRULEs recur past the stored times; regular zones compress to open-ended RRULE
    // observances anyway, so the horizon only bounds irregular zones. The span cap keeps a
    // pathological far-future event from turning the transition scan into a seconds-long stall.
    if (hasRrule) maxYear = Math.max(maxYear, new Date().getUTCFullYear() + 5);
    maxYear = Math.min(maxYear, minYear + 50);

    const lines: string[] = [];
    for (const tzid of tzids) {
        lines.push(...buildVTimezone(tzid, minYear, maxYear));
    }
    return lines;
}

export function serializeEventForImip(event: CalendarEvent, method: 'REQUEST' | 'REPLY' | 'CANCEL'): string {
    return wrapInVCalendar([...vtimezoneLines([event]), ...buildVEvent(event, { rsvp: method === 'REQUEST' })], method);
}

export function eventsToIcs(events: CalendarEvent[]): string {
    if (events.length === 0) return wrapInVCalendar([]);

    // Group by uid; master events (no recurrenceDate) come first within each group
    const groups = new Map<string, CalendarEvent[]>();
    for (const event of events) {
        const group = groups.get(event.uid) ?? [];
        groups.set(event.uid, group);
        if (event.recurrenceDate == null) {
            group.unshift(event);
        } else {
            group.push(event);
        }
    }

    const eventLines: string[] = [];
    for (const group of groups.values()) {
        const master = group[0].recurrenceDate == null ? group[0] : undefined;
        const cancelled = master ? group.filter((e) => e.recurrenceDate != null && e.status === 'cancelled') : [];
        for (const event of group) {
            if (master && event.recurrenceDate != null && event.status === 'cancelled') continue;
            eventLines.push(...buildVEvent(event, { master, exdates: event === master ? cancelled : undefined }));
        }
    }

    return wrapInVCalendar([...vtimezoneLines(events), ...eventLines]);
}
