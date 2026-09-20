import { describe, expect, test } from 'bun:test';
import {
    ICS_PREVIEW_MAX_ATTENDEES,
    ICS_PREVIEW_MAX_DESCRIPTION_CHARS,
    ICS_PREVIEW_MAX_EVENTS,
} from '@workspace/lib/constants/calendar';
import { ApiError } from '../../lib/core/errors';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { buildIcsPreviewPayload } from '../../lib/preview/ics-preview';

// The payload the quick look reads. Every value in it came from a file a stranger wrote, and the card
// that draws it must never fetch anything the file named.

const HOSTILE = 'evil.example';

const vcal = (lines: string[], head: string[] = []) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...head, ...lines, 'END:VCALENDAR'].join('\r\n');

const payloadOf = (text: string) => buildIcsPreviewPayload(toTransferableText(text));

const event = (uid: string, lines: string[]) => ['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'END:VEVENT'];

const timed = (uid: string, start: string, end: string, extra: string[] = []) =>
    event(uid, [`DTSTART:${start}`, `DTEND:${end}`, ...extra]);

// A Thunderbird-style export: several series in one file, VTIMEZONE blocks up front, EXDATEs rather than
// cancelled override VEVENTs.
const THUNDERBIRD = vcal([
    ...event('weekly@eigen', [
        'DTSTART;TZID=Europe/Amsterdam:20260302T090000',
        'DTEND;TZID=Europe/Amsterdam:20260302T093000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'EXDATE;TZID=Europe/Amsterdam:20260316T090000',
        'SUMMARY:Standup',
        'LOCATION:Kitchen',
        'DESCRIPTION:Weekly standup',
    ]),
    ...timed('lunch@eigen', '20260304T110000Z', '20260304T120000Z'),
]);

// An Apple-style invitation: METHOD:REQUEST, an ORGANIZER, ATTENDEEs, a VALARM and a VTIMEZONE.
const APPLE_INVITE = vcal(
    event('invite@eigen', [
        'DTSTART;TZID=America/New_York:20260420T140000',
        'DTEND;TZID=America/New_York:20260420T150000',
        'SUMMARY:Design review',
        'LOCATION:Studio B',
        'ORGANIZER;CN=Ada Lovelace:mailto:ada@external.com',
        'ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:bob@example.com',
        'ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT:MAILTO:carol@example.com',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        'END:VALARM',
    ]),
    [
        'METHOD:REQUEST',
        'BEGIN:VTIMEZONE',
        'TZID:America/New_York',
        'BEGIN:STANDARD',
        'DTSTART:19701101T020000',
        'TZOFFSETFROM:-0400',
        'TZOFFSETTO:-0500',
        'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700308T020000',
        'TZOFFSETFROM:-0500',
        'TZOFFSETTO:-0400',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
    ],
);

describe('buildIcsPreviewPayload', () => {
    test('a multi-series export lists its masters, sorted by start', () => {
        const payload = payloadOf(THUNDERBIRD);

        expect(payload.method).toBeUndefined();
        expect(payload.total).toBe(2);
        expect(payload.dropped).toBe(0);
        // The EXDATE is part of its series, not a row of its own.
        expect(payload.events.map((e) => e.uid)).toEqual(['weekly@eigen', 'lunch@eigen']);
        expect(payload.events[0]).toMatchObject({
            title: 'Standup',
            description: 'Weekly standup',
            location: 'Kitchen',
            start: '2026-03-02T08:00:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            status: 'confirmed',
            organizer: null,
            attendees: [],
            droppedAttendees: 0,
        });
    });

    test('an invitation carries its method, organizer and attendees', () => {
        const payload = payloadOf(APPLE_INVITE);

        expect(payload.method).toBe('REQUEST');
        expect(payload.events).toHaveLength(1);
        const [invite] = payload.events;
        expect(invite?.title).toBe('Design review');
        expect(invite?.location).toBe('Studio B');
        expect(invite?.timezone).toBe('America/New_York');
        expect(invite?.start).toBe('2026-04-20T18:00:00.000Z');
        expect(invite?.organizer).toEqual({ userId: '', email: 'ada@external.com', name: 'Ada Lovelace' });
        expect(invite?.attendees).toEqual([
            { email: 'bob@example.com', name: 'Bob', status: 'accepted', role: 'required' },
            { email: 'carol@example.com', status: 'pending', role: 'optional' },
        ]);
    });

    // An override moves one occurrence of a series; it is not an event of its own in a quick look.
    test('an override and its series are one row', () => {
        const payload = payloadOf(
            vcal([
                ...event('series@eigen', [
                    'DTSTART;TZID=Europe/Amsterdam:20260302T090000',
                    'DTEND;TZID=Europe/Amsterdam:20260302T093000',
                    'RRULE:FREQ=WEEKLY',
                ]),
                ...event('series@eigen', [
                    'RECURRENCE-ID;TZID=Europe/Amsterdam:20260309T090000',
                    'DTSTART;TZID=Europe/Amsterdam:20260309T140000',
                    'DTEND;TZID=Europe/Amsterdam:20260309T143000',
                ]),
            ]),
        );

        expect(payload.total).toBe(1);
        expect(payload.events).toHaveLength(1);
        expect(payload.events[0]?.rrule).toBe('FREQ=WEEKLY');
    });

    test('an all-day event travels as bare dates with the exclusive end the domain stores', () => {
        const payload = payloadOf(
            vcal(event('holiday@eigen', ['DTSTART;VALUE=DATE:20260920', 'DTEND;VALUE=DATE:20260922'])),
        );

        expect(payload.events[0]).toMatchObject({ allDay: true, start: '2026-09-20', end: '2026-09-22' });
    });

    test('a feed past the event ceiling keeps the first events and counts the rest', () => {
        const extra = 50;
        const payload = payloadOf(
            vcal(
                Array.from({ length: ICS_PREVIEW_MAX_EVENTS + extra }, (_, i) =>
                    // Descending starts, so the sort is what puts the kept ones in order.
                    timed(
                        `bulk-${i}@eigen`,
                        `2026060${1 + (i % 9)}T${String(i % 24).padStart(2, '0')}0000Z`,
                        '20260610T120000Z',
                    ),
                ).flat(),
            ),
        );

        expect(payload.total).toBe(ICS_PREVIEW_MAX_EVENTS + extra);
        expect(payload.events).toHaveLength(ICS_PREVIEW_MAX_EVENTS);
        expect(payload.dropped).toBe(extra);
        const starts = payload.events.map((e) => e.start);
        expect([...starts].sort()).toEqual(starts);
    });

    test('an event with a crowd of attendees is capped, and the rest counted', () => {
        const attendees = Array.from({ length: 5000 }, (_, i) => `ATTENDEE:mailto:guest-${i}@example.com`);
        const payload = payloadOf(vcal(timed('crowd@eigen', '20260601T100000Z', '20260601T110000Z', attendees)));

        expect(payload.events[0]?.attendees).toHaveLength(ICS_PREVIEW_MAX_ATTENDEES);
        expect(payload.events[0]?.droppedAttendees).toBe(5000 - ICS_PREVIEW_MAX_ATTENDEES);
    });

    test('a novel-length description is cut to the payload ceiling', () => {
        const payload = payloadOf(
            vcal(
                timed('long@eigen', '20260601T100000Z', '20260601T110000Z', [
                    `DESCRIPTION:${'x'.repeat(ICS_PREVIEW_MAX_DESCRIPTION_CHARS + 5000)}`,
                ]),
            ),
        );

        expect(payload.events[0]?.description?.length).toBe(ICS_PREVIEW_MAX_DESCRIPTION_CHARS);
    });

    // A card that fetched what the file named would beacon whoever opens the quick look.
    test('nothing the file points at reaches the payload', () => {
        const payload = payloadOf(
            vcal(
                timed('refs@eigen', '20260601T100000Z', '20260601T110000Z', [
                    `ATTACH:https://${HOSTILE}/agenda.pdf`,
                    `ATTACH;FMTTYPE=image/png;VALUE=BINARY;ENCODING=BASE64:QUFB`,
                    `URL:https://${HOSTILE}/meeting`,
                    `IMAGE;VALUE=URI:https://${HOSTILE}/banner.png`,
                    `ORGANIZER;DIR="https://${HOSTILE}/ldap":mailto:ada@external.com`,
                    `ATTENDEE;DIR="https://${HOSTILE}/ldap":mailto:bob@example.com`,
                ]),
            ),
        );

        expect(JSON.stringify(payload)).not.toContain(HOSTILE);
        expect(payload.events[0]?.organizer?.email).toBe('ada@external.com');
    });

    // rrule iterates to the query window for a sub-daily recurrence, so the parser nulls it — and the
    // preview inherits that rather than handing the card a rule it would expand.
    test('a sub-daily recurrence builds fast and carries no rule', () => {
        const startedAt = performance.now();
        const payload = payloadOf(
            vcal(timed('bomb@eigen', '20260601T100000Z', '20260601T110000Z', ['RRULE:FREQ=SECONDLY;COUNT=1000000'])),
        );

        expect(payload.events[0]?.rrule).toBeNull();
        expect(performance.now() - startedAt).toBeLessThan(1000);
    });

    test('a file the parser refuses is a controlled failure, not a throw the runner reports as a crash', () => {
        expect(() => payloadOf('not a calendar at all')).toThrow(new ApiError(422, 'Could not read this file'));
    });
});
