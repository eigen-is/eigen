import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';

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

function formatDateTimeUTC(epochSeconds: number): string {
    const d = new Date(epochSeconds * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function formatDateUTC(epochSeconds: number): string {
    const d = new Date(epochSeconds * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

// Convert epoch seconds to local time in the given IANA timezone, formatted as YYYYMMDDTHHmmSS
function formatDateTimeInTZ(epochSeconds: number, tz: string): string {
    const d = new Date(epochSeconds * 1000);
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

function buildVEvent(event: CalendarEvent): string[] {
    const lines: string[] = [];

    const prop = (line: string) => lines.push(foldLine(line));

    prop('BEGIN:VEVENT');
    prop(`UID:${event.uid}`);
    prop(`SUMMARY:${event.title}`);

    // DTSTART / DTEND
    if (event.allDay) {
        prop(`DTSTART;VALUE=DATE:${formatDateUTC(event.startTime)}`);
        prop(`DTEND;VALUE=DATE:${formatDateUTC(event.endTime)}`);
    } else if (event.timezone) {
        prop(`DTSTART;TZID=${event.timezone}:${formatDateTimeInTZ(event.startTime, event.timezone)}`);
        prop(`DTEND;TZID=${event.timezone}:${formatDateTimeInTZ(event.endTime, event.timezone)}`);
    } else {
        prop(`DTSTART:${formatDateTimeUTC(event.startTime)}`);
        prop(`DTEND:${formatDateTimeUTC(event.endTime)}`);
    }

    if (event.description) prop(`DESCRIPTION:${event.description}`);
    if (event.location) prop(`LOCATION:${event.location}`);

    prop(`STATUS:${event.status.toUpperCase()}`);
    prop(`SEQUENCE:${event.sequence}`);
    prop(`CREATED:${formatDateTimeUTC(event.createdAt ?? 0)}`);
    prop(`LAST-MODIFIED:${formatDateTimeUTC(event.updatedAt ?? 0)}`);
    prop(`DTSTAMP:${formatDateTimeUTC(event.updatedAt ?? 0)}`);

    if (event.rrule) prop(`RRULE:${event.rrule}`);

    // RECURRENCE-ID for exception events
    if (event.recurrenceDate) {
        if (event.allDay) {
            // recurrenceDate is stored as YYYY-MM-DD; strip the dashes for iCal
            const compact = event.recurrenceDate.replace(/-/g, '');
            prop(`RECURRENCE-ID;VALUE=DATE:${compact}`);
        } else if (event.timezone) {
            prop(
                `RECURRENCE-ID;TZID=${event.timezone}:${formatDateTimeInTZ(
                    new Date(event.recurrenceDate).getTime() / 1000,
                    event.timezone,
                )}`,
            );
        } else {
            prop(`RECURRENCE-ID:${formatDateTimeUTC(new Date(event.recurrenceDate).getTime() / 1000)}`);
        }
    }

    // ATTENDEE lines
    for (const attendee of event.data?.attendees ?? []) {
        const cn = attendee.name ? `;CN=${attendee.name}` : '';
        prop(
            `ATTENDEE;ROLE=${mapAttendeeRole(attendee.role)};PARTSTAT=${mapAttendeeStatus(attendee.status)}${cn}:mailto:${attendee.email}`,
        );
    }

    // ORGANIZER
    const organizer = event.data?.organizer;
    if (organizer) {
        const cn = organizer.name ? `;CN=${organizer.name}` : '';
        prop(`ORGANIZER${cn}:mailto:${organizer.email}`);
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

function wrapInVCalendar(eventLines: string[]): string {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eigen//CalDAV//EN', ...eventLines, 'END:VCALENDAR'];
    return `${lines.join('\r\n')}\r\n`;
}

export function eventToIcs(event: CalendarEvent): string {
    if (event.icsBlob) return event.icsBlob;
    return wrapInVCalendar(buildVEvent(event));
}

export function eventsToIcs(events: CalendarEvent[]): string {
    if (events.length === 0) return wrapInVCalendar([]);

    // Check icsBlob on the first event — if it exists, return it directly (round-trip fidelity)
    if (events[0].icsBlob) return events[0].icsBlob;

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
