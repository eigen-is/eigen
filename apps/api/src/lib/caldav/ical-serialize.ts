import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { normalizeTimezone } from '../calendar/timezone';

// RFC 5545 §3.3.11 — escape TEXT values
function escapeICalText(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').replace(/\r/g, '');
}

// Escape a value for use inside a double-quoted PARAM-VALUE (e.g. CN="...").
// Double quotes would break out of the parameter; CRLF could inject properties.
function escapeICalParamValue(s: string): string {
    return s.replace(/"/g, "'").replace(/[\r\n]/g, '');
}

// RFC 5545 §3.1 — fold lines longer than 75 octets with CRLF + single space
function foldLine(line: string): string {
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
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatDateUTC(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// Format a Date as local wall-clock time in the given IANA timezone (YYYYMMDDTHHmmSS)
function formatDateTimeInTZ(d: Date, tz: string): string {
    // Use Intl to extract local-time parts in the target timezone
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const partsMap = new Map(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return `${partsMap.get('year')}${partsMap.get('month')}${partsMap.get('day')}T${partsMap.get('hour')}${partsMap.get('minute')}${partsMap.get('second')}`;
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

function buildVEvent(event: CalendarEvent, options?: { rsvp?: boolean }): string[] {
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

    // RECURRENCE-ID for exception events — use startTime (the actual occurrence time),
    // not the date string, so timed events have the correct time component
    if (event.recurrenceDate) {
        if (event.allDay) {
            const compact = event.recurrenceDate.replace(/-/g, '');
            prop(`RECURRENCE-ID;VALUE=DATE:${compact}`);
        } else if (tzid) {
            prop(`RECURRENCE-ID;TZID=${tzid}:${formatDateTimeInTZ(event.startTime, tzid)}`);
        } else {
            prop(`RECURRENCE-ID:${formatDateTimeUTC(event.startTime)}`);
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

export function serializeEventForImip(event: CalendarEvent, method: 'REQUEST' | 'REPLY' | 'CANCEL'): string {
    return wrapInVCalendar(buildVEvent(event, { rsvp: method === 'REQUEST' }), method);
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
        for (const event of group) {
            eventLines.push(...buildVEvent(event));
        }
    }

    return wrapInVCalendar(eventLines);
}
