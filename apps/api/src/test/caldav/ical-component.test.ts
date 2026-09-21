// The ical.js component seam: build a VCALENDAR from rows, patch one VEVENT in place, re-stamp an
// untrusted body against the stored resource, strip Eigen's own lines. Fidelity is judged as jCal
// equality per property — ical.js rewrites `X-ADDRESS="a\nb"` to `a^nb`, drops a default `VALUE=URI`,
// reorders parameters and escapes a bare `;`, so a byte assert fails on the first run and a
// name-present assert passes on a mangled parameter.
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import {
    addExclusion,
    buildResource,
    eventsToIcs,
    patchEvent,
    putOverride,
    removeExclusion,
    restampResource,
    serializeEventForImip,
    serializeResource,
    stripEigenStamps,
} from '../../lib/caldav/ical-component';
import { parseIcs, parseResource, projectResource } from '../../lib/caldav/ical-parse';
import { vcal } from '../ics-test-helpers';

const CTX = { now: new Date('2026-06-01T10:00:00Z'), actorIsOrganizer: true };

const parse = (ics: string): ICAL.Component => new ICAL.Component(ICAL.parse(ics));
const masterOf = (resource: ICAL.Component): ICAL.Component =>
    resource.getAllSubcomponents('vevent').find((v) => !v.getFirstProperty('recurrence-id'))!;
const overridesOf = (resource: ICAL.Component): ICAL.Component[] =>
    resource.getAllSubcomponents('vevent').filter((v) => v.getFirstProperty('recurrence-id'));

// Every property of a component tree in jCal form, keyed by name so parameter order and property
// order never decide equality.
type Snapshot = Record<string, unknown[]>;

function snapshot(comp: ICAL.Component): Snapshot {
    const out: Snapshot = {};
    for (const prop of comp.getAllProperties()) {
        (out[prop.name] ??= []).push(prop.toJSON());
    }
    for (const sub of comp.getAllSubcomponents()) {
        (out[`${sub.name}/`] ??= []).push(snapshot(sub));
    }
    return out;
}

function changedProperties(before: ICAL.Component, after: ICAL.Component): string[] {
    const a = snapshot(before);
    const b = snapshot(after);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((name) => JSON.stringify(a[name]) !== JSON.stringify(b[name]))
        .sort();
}

const VTZ_AMS = [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Amsterdam',
    'X-LIC-LOCATION:Europe/Amsterdam',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
];

// One client-written series carrying everything Eigen does not model, plus an override with a RANGE.
const KITCHEN_MASTER = [
    'BEGIN:VEVENT',
    'UID:kitchen@client',
    'DTSTAMP:20260101T000000Z',
    'CREATED:20251201T090000Z',
    'LAST-MODIFIED:20251215T090000Z',
    'SEQUENCE:2',
    'SUMMARY:Kitchen sink 🎉 with a title long enough to cross the seventy-five octet fold boundary',
    'DESCRIPTION:has a ; semicolon and a , comma',
    'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
    'DTEND;TZID=Europe/Amsterdam:20260415T130000',
    'RRULE:FREQ=HOURLY;COUNT=10',
    'RDATE;TZID=Europe/Amsterdam:20260501T120000',
    'GEO:52.37;4.89',
    'CATEGORIES:work,travel',
    'ATTACH;FMTTYPE=text/plain;VALUE=URI:https://example.com/agenda.txt',
    'ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=image/png:aGVsbG8=',
    'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Herengracht 1\\nAmsterdam";X-APPLE-RADIUS=49;X-TITLE=Office:geo:52.37,4.89',
    'ORGANIZER;CN=Alice:mailto:alice@eigen.example',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;X-NUM-GUESTS=2;CN=Bob:mailto:bob@x.com',
    'ATTENDEE;CUTYPE=ROOM;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;SCHEDULE-STATUS=2.0;CN=Room 42:mailto:room42@x.com',
    'BEGIN:VALARM',
    'ACTION:AUDIO',
    'TRIGGER;RELATED=END:-PT10M',
    'ATTACH;FMTTYPE=audio/basic:ftp://example.com/pub/sounds/bell-01.aud',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
];

const KITCHEN_OVERRIDE = [
    'BEGIN:VEVENT',
    'UID:kitchen@client',
    'RECURRENCE-ID;TZID=Europe/Amsterdam;RANGE=THISANDFUTURE:20260422T120000',
    'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Europe/Amsterdam:20260422T140000',
    'DTEND;TZID=Europe/Amsterdam:20260422T150000',
    'SUMMARY:Moved occurrence',
    'END:VEVENT',
];

const KITCHEN_SINK = vcal(VTZ_AMS, KITCHEN_MASTER, KITCHEN_OVERRIDE);

const MASTER: CalendarEvent = {
    id: 'evt-master',
    calendarId: 'cal-1',
    uid: 'series@eigen',
    uri: 'series.ics',
    title: 'Weekly sync',
    description: 'Agenda in the doc',
    location: 'Room 1',
    startTime: new Date('2026-04-15T10:00:00Z'),
    endTime: new Date('2026-04-15T11:00:00Z'),
    allDay: false,
    rrule: 'FREQ=WEEKLY;COUNT=8',
    timezone: 'Europe/Amsterdam',
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 3,
    etag: 'e',
    data: {
        attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'pending', role: 'required' }],
        organizer: { userId: 'alice-id', email: 'alice@eigen.example', name: 'Alice' },
        organizerEventId: 'org-evt-1',
        color: '#ff8800',
        reminders: [{ type: 'notification', minutes: 15 }],
        url: 'https://example.com/meeting',
    },
    createByUserId: 'alice-id',
    createdAt: new Date('2026-01-02T03:04:05Z'),
    updatedAt: new Date('2026-02-03T04:05:06Z'),
};

const OVERRIDE: CalendarEvent = {
    ...MASTER,
    id: 'evt-override',
    parentEventId: MASTER.id,
    recurrenceDate: '2026-04-22',
    rrule: null,
    title: 'Weekly sync (moved)',
    startTime: new Date('2026-04-22T12:00:00Z'),
    endTime: new Date('2026-04-22T13:00:00Z'),
};

const EXCLUSION: CalendarEvent = {
    ...MASTER,
    id: 'evt-exclusion',
    parentEventId: MASTER.id,
    recurrenceDate: '2026-04-29',
    rrule: null,
    status: 'cancelled',
    sequence: 5,
    data: null,
};

describe('kitchen-sink fidelity under a patch', () => {
    test('a title patch leaves every other property of the master jCal-equal', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink' }, CTX);

        expect(changedProperties(before, masterOf(resource))).toEqual(['dtstamp', 'last-modified', 'summary']);
        expect(masterOf(resource).getFirstPropertyValue('summary')).toBe('Renamed sink');
    });

    test('a title patch leaves the override untouched', () => {
        const before = overridesOf(parse(KITCHEN_SINK))[0];
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink' }, CTX);

        expect(changedProperties(before, overridesOf(resource)[0])).toEqual([]);
    });

    test('patching one attendee status changes only that ATTENDEE property', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            {
                data: {
                    attendees: [
                        { email: 'bob@x.com', name: 'Bob', status: 'accepted', role: 'required' },
                        { email: 'room42@x.com', name: 'Room 42', status: 'accepted', role: 'optional' },
                    ],
                },
            },
            CTX,
        );

        expect(changedProperties(before, masterOf(resource))).toEqual(['attendee', 'dtstamp', 'last-modified']);
        const [bob, room] = masterOf(resource).getAllProperties('attendee');
        expect(bob.getFirstParameter('partstat')).toBe('ACCEPTED');
        // Parameters Eigen does not model ride through the edit untouched.
        expect(bob.getFirstParameter('x-num-guests')).toBe('2');
        expect(bob.getFirstParameter('rsvp')).toBe('TRUE');
        expect(bob.getFirstParameter('cutype')).toBe('INDIVIDUAL');
        expect(JSON.stringify(room.toJSON())).toBe(JSON.stringify(before.getAllProperties('attendee')[1].toJSON()));
    });

    test('removing an attendee drops that property and keeps the other whole', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            { data: { attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'pending', role: 'required' }] } },
            CTX,
        );

        const attendees = masterOf(resource).getAllProperties('attendee');
        expect(attendees).toHaveLength(1);
        expect(JSON.stringify(attendees[0].toJSON())).toBe(
            JSON.stringify(before.getAllProperties('attendee')[0].toJSON()),
        );
    });

    test('a null rrule in the patch does not remove the sub-daily RRULE', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink', rrule: null }, CTX);

        expect(String(masterOf(resource).getFirstPropertyValue('rrule'))).toBe('FREQ=HOURLY;COUNT=10');
    });

    test('an unchanged reminder list does not touch the AUDIO alarm', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            {
                data: {
                    reminders: [
                        { type: 'notification', minutes: 10 },
                        { type: 'notification', minutes: 15 },
                    ],
                },
            },
            CTX,
        );

        expect(changedProperties(before, masterOf(resource))).toEqual([]);
    });

    test('a changed reminder list replaces the whole VALARM set', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, { data: { reminders: [{ type: 'notification', minutes: 5 }] } }, CTX);

        const alarms = masterOf(resource).getAllSubcomponents('valarm');
        expect(alarms).toHaveLength(1);
        expect(alarms[0].getFirstPropertyValue('action')).toBe('DISPLAY');
        expect(String(alarms[0].getFirstPropertyValue('trigger'))).toBe('-PT5M');
    });

    test('patching the override addresses it by recurrence key', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, '2026-04-22', { title: 'Override renamed' }, CTX);

        expect(overridesOf(resource)[0].getFirstPropertyValue('summary')).toBe('Override renamed');
        expect(changedProperties(before, masterOf(resource))).toEqual([]);
    });

    test('an unchanged title writes nothing at all', () => {
        const before = masterOf(parse(KITCHEN_SINK));
        const resource = parse(KITCHEN_SINK);
        expect(patchEvent(resource, null, { title: before.getFirstPropertyValue('summary') as string }, CTX)).toBe(
            false,
        );
        expect(changedProperties(before, masterOf(resource))).toEqual([]);
    });
});

describe('SEQUENCE', () => {
    const timesPatch = { startTime: new Date('2026-04-15T14:00:00Z'), endTime: new Date('2026-04-15T15:00:00Z') };

    test('bumps on a scheduling change by the organizer of an event with attendees', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, timesPatch, CTX);
        expect(Number(masterOf(resource).getFirstPropertyValue('sequence'))).toBe(3);
    });

    test('does not bump when the actor is not the organizer', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, timesPatch, { ...CTX, actorIsOrganizer: false });
        expect(Number(masterOf(resource).getFirstPropertyValue('sequence'))).toBe(2);
    });

    test('does not bump when the event has no attendees', () => {
        const resource = parse(vcal(VTZ_AMS, KITCHEN_MASTER));
        masterOf(resource).removeAllProperties('attendee');
        patchEvent(resource, null, timesPatch, CTX);
        expect(Number(masterOf(resource).getFirstPropertyValue('sequence'))).toBe(2);
    });

    test('does not bump for a change that is not scheduling-significant', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink', location: 'Room 9' }, CTX);
        expect(Number(masterOf(resource).getFirstPropertyValue('sequence'))).toBe(2);
    });

    test('bumps on an attendee-set change and never moves CREATED', () => {
        const resource = parse(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            { data: { attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'pending', role: 'required' }] } },
            CTX,
        );
        expect(Number(masterOf(resource).getFirstPropertyValue('sequence'))).toBe(3);
        expect(String(masterOf(resource).getFirstPropertyValue('created'))).toBe('2025-12-01T09:00:00Z');
    });
});

describe('stamp trust', () => {
    const stored = () => parse(serializeResource(buildResource([MASTER, OVERRIDE, EXCLUSION])));

    // A client that rewrote every EXDATE into the UTC-Z comma-joined form and forged Eigen's own lines.
    const forged = [
        'BEGIN:VEVENT',
        'UID:series@eigen',
        'DTSTAMP:20260101T000000Z',
        'SUMMARY:Weekly sync',
        'SEQUENCE:3',
        'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
        'DTEND;TZID=Europe/Amsterdam:20260415T130000',
        'RRULE:FREQ=WEEKLY;COUNT=8',
        'EXDATE:20260429T100000Z',
        'ORGANIZER;CN=Alice:mailto:alice@eigen.example',
        'X-EIGEN-EVENT-ID:forged-id',
        'X-EIGEN-CREATED-BY:mallory',
        'X-EIGEN-ORGANIZER-EVENT:forged-org-event',
        'X-EIGEN-ORGANIZER-USER:mallory',
        'X-EIGEN-COLOR:#000000',
        'X-EIGEN-EXDATE;X-EIGEN-EVENT-ID=forged-exc;X-EIGEN-SEQ=99:2026-04-29',
        'DTSTART;X-EIGEN-EVENT-ID=forged-param:20260415T100000Z',
        'END:VEVENT',
    ];

    test('the untrusted entry reads no stamp the body carries', () => {
        const { events } = parseIcs(vcal(VTZ_AMS, forged));
        const [master, exclusion] = events;

        expect(master.data?.organizer?.userId).toBe('');
        expect(master.data?.organizerEventId).toBeUndefined();
        expect(master.data?.color).toBeUndefined();
        expect(Object.keys(master)).not.toContain('eventId');
        expect(Object.keys(master)).not.toContain('createByUserId');
        expect(Object.keys(master)).not.toContain('importedOrganizer');
        // The forged exclusion stamp named id `forged-exc` and SEQUENCE 99; an untrusted EXDATE inherits
        // the master's.
        expect(exclusion.recurrenceDate).toBe('2026-04-29');
        expect(exclusion.sequence).toBe(3);
        expect(Object.keys(exclusion)).not.toContain('eventId');
    });

    test('the trusted projection of the same bytes reads every stamp', () => {
        const { events } = projectResource(parseResource(vcal(VTZ_AMS, forged)));
        const [master, exclusion] = events;

        expect(master.eventId).toBe('forged-id');
        expect(master.createByUserId).toBe('mallory');
        expect(master.data?.organizer?.userId).toBe('mallory');
        expect(master.data?.organizerEventId).toBe('forged-org-event');
        expect(master.data?.color).toBe('#000000');
        expect(exclusion.eventId).toBe('forged-exc');
        expect(exclusion.sequence).toBe(99);
    });

    test('every forged stamp is discarded and the stored one comes back', () => {
        const incoming = parse(vcal(VTZ_AMS, forged));
        restampResource(incoming, stored());

        const master = masterOf(incoming);
        expect(master.getFirstPropertyValue('x-eigen-event-id')).toBe('evt-master');
        expect(master.getFirstPropertyValue('x-eigen-created-by')).toBe('alice-id');
        expect(master.getFirstPropertyValue('x-eigen-organizer-event')).toBe('org-evt-1');
        expect(master.getFirstPropertyValue('x-eigen-organizer-user')).toBe('alice-id');
        expect(master.getFirstPropertyValue('x-eigen-color')).toBe('#ff8800');
        const stamp = master.getAllProperties('x-eigen-exdate')[0];
        expect(stamp.getFirstValue()).toBe('2026-04-29');
        expect(stamp.getFirstParameter('x-eigen-event-id')).toBe('evt-exclusion');
        expect(stamp.getFirstParameter('x-eigen-seq')).toBe('5');
    });

    test('a forged X-EIGEN parameter on a standard property is discarded', () => {
        const incoming = parse(vcal(VTZ_AMS, forged));
        restampResource(incoming, stored());
        expect(serializeResource(incoming)).not.toContain('forged-param');
    });

    test('a body that stripped every X- line gets its ids and links back', () => {
        const bare = parse(serializeResource(buildResource([MASTER, OVERRIDE, EXCLUSION])));
        stripEigenStamps(bare);
        expect(serializeResource(bare)).not.toContain('X-EIGEN');

        restampResource(bare, stored());
        expect(masterOf(bare).getFirstPropertyValue('x-eigen-event-id')).toBe('evt-master');
        expect(overridesOf(bare)[0].getFirstPropertyValue('x-eigen-event-id')).toBe('evt-override');
        expect(masterOf(bare).getAllProperties('x-eigen-exdate')[0].getFirstParameter('x-eigen-event-id')).toBe(
            'evt-exclusion',
        );
    });

    test('an EXDATE rewritten to a comma-joined UTC property still matches both stamps by key', () => {
        const twoExclusions = buildResource([
            MASTER,
            EXCLUSION,
            { ...EXCLUSION, id: 'evt-exclusion-2', recurrenceDate: '2026-05-06', sequence: 7 },
        ]);
        const client = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync',
            'SEQUENCE:3',
            'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
            'DTEND;TZID=Europe/Amsterdam:20260415T130000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'EXDATE:20260429T100000Z,20260506T100000Z',
            'END:VEVENT',
        ];
        const incoming = parse(vcal(VTZ_AMS, client));
        restampResource(incoming, parse(serializeResource(twoExclusions)));

        const stamps = masterOf(incoming).getAllProperties('x-eigen-exdate');
        expect(stamps.map((s) => [s.getFirstValue(), s.getFirstParameter('x-eigen-event-id')])).toEqual([
            ['2026-04-29', 'evt-exclusion'],
            ['2026-05-06', 'evt-exclusion-2'],
        ]);
    });

    test('an EXDATE the client added gets a fresh id and the master sequence', () => {
        const client = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync',
            'SEQUENCE:3',
            'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
            'DTEND;TZID=Europe/Amsterdam:20260415T130000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'EXDATE;TZID=Europe/Amsterdam:20260429T120000',
            'EXDATE;TZID=Europe/Amsterdam:20260513T120000',
            'END:VEVENT',
        ];
        const incoming = parse(vcal(VTZ_AMS, client));
        restampResource(incoming, stored());

        const byKey = new Map(
            masterOf(incoming)
                .getAllProperties('x-eigen-exdate')
                .map((s) => [String(s.getFirstValue()), s]),
        );
        expect(byKey.get('2026-04-29')!.getFirstParameter('x-eigen-event-id')).toBe('evt-exclusion');
        const minted = byKey.get('2026-05-13')!;
        expect(minted.getFirstParameter('x-eigen-event-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(minted.getFirstParameter('x-eigen-seq')).toBe('3');
    });

    test('an EXDATE the client removed loses its stamp', () => {
        const client = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync',
            'SEQUENCE:3',
            'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
            'DTEND;TZID=Europe/Amsterdam:20260415T130000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'END:VEVENT',
        ];
        const incoming = parse(vcal(VTZ_AMS, client));
        restampResource(incoming, stored());
        expect(masterOf(incoming).getAllProperties('x-eigen-exdate')).toHaveLength(0);
    });

    test('an all-day series matches its VALUE=DATE exclusion by key', () => {
        const allDayMaster: CalendarEvent = {
            ...MASTER,
            allDay: true,
            timezone: null,
            startTime: new Date('2026-04-15T00:00:00Z'),
            endTime: new Date('2026-04-16T00:00:00Z'),
        };
        const allDayExclusion: CalendarEvent = { ...EXCLUSION, allDay: true, timezone: null };
        const storedAllDay = parse(serializeResource(buildResource([allDayMaster, allDayExclusion])));
        expect(serializeResource(buildResource([allDayMaster, allDayExclusion]))).toContain(
            'EXDATE;VALUE=DATE:20260429',
        );

        const client = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync',
            'SEQUENCE:3',
            'DTSTART;VALUE=DATE:20260415',
            'DTEND;VALUE=DATE:20260416',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'EXDATE;VALUE=DATE:20260429',
            'END:VEVENT',
        ];
        const incoming = parse(vcal(client));
        restampResource(incoming, storedAllDay);
        expect(masterOf(incoming).getAllProperties('x-eigen-exdate')[0].getFirstParameter('x-eigen-event-id')).toBe(
            'evt-exclusion',
        );
    });

    test('a malformed stamp is treated as absent, never thrown on', () => {
        const junk = [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync',
            'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
            'DTEND;TZID=Europe/Amsterdam:20260415T130000',
            'RRULE:FREQ=WEEKLY;COUNT=8',
            'EXDATE;TZID=Europe/Amsterdam:20260429T120000',
            'X-EIGEN-EXDATE;X-EIGEN-SEQ=not-a-number:not-a-date',
            'END:VEVENT',
        ];
        const storedJunk = parse(vcal(VTZ_AMS, junk));
        const incoming = parse(vcal(VTZ_AMS, junk));
        restampResource(incoming, storedJunk);

        const stamp = masterOf(incoming).getAllProperties('x-eigen-exdate')[0];
        expect(stamp.getFirstValue()).toBe('2026-04-29');
        expect(stamp.getFirstParameter('x-eigen-event-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(stamp.getFirstParameter('x-eigen-seq')).toBe('0');

        expect(projectResource(storedJunk).events[1].sequence).toBe(0);
    });

    test('with no stored resource everything is minted and only trusted organizer stamps are set', () => {
        const incoming = parse(vcal(VTZ_AMS, forged));
        restampResource(incoming, null, {
            createByUserId: 'carol-id',
            organizerEventId: 'evt-x',
            organizerUserId: 'carol-id',
        });

        const master = masterOf(incoming);
        expect(master.getFirstPropertyValue('x-eigen-event-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(master.getFirstPropertyValue('x-eigen-created-by')).toBe('carol-id');
        expect(master.getFirstPropertyValue('x-eigen-organizer-event')).toBe('evt-x');
        expect(master.getFirstPropertyValue('x-eigen-organizer-user')).toBe('carol-id');
        expect(master.getFirstPropertyValue('x-eigen-color')).toBeNull();
    });

    test('with no stored resource and no trusted fields no organizer stamp is written', () => {
        const incoming = parse(vcal(VTZ_AMS, forged));
        restampResource(incoming, null);
        expect(serializeResource(incoming)).not.toContain('X-EIGEN-ORGANIZER');
        expect(serializeResource(incoming)).not.toContain('X-EIGEN-CREATED-BY');
    });
});

describe('round trip build → serialize → project', () => {
    const variants: Array<{ name: string; master: CalendarEvent }> = [
        { name: 'timed with a TZID', master: MASTER },
        { name: 'timed in UTC', master: { ...MASTER, timezone: null } },
        {
            name: 'all-day',
            master: {
                ...MASTER,
                allDay: true,
                timezone: null,
                startTime: new Date('2026-04-15T00:00:00Z'),
                endTime: new Date('2026-04-16T00:00:00Z'),
            },
        },
    ];

    for (const { name, master } of variants) {
        test(`${name} gives back every row fact`, () => {
            const override = { ...OVERRIDE, allDay: master.allDay, timezone: master.timezone };
            const exclusion = { ...EXCLUSION, allDay: master.allDay, timezone: master.timezone };
            const ics = serializeResource(buildResource([master, override, exclusion]));
            const { events } = projectResource(parseResource(ics));

            const back = events.find((e) => !e.recurrenceDate)!;
            expect(back.eventId).toBe('evt-master');
            expect(back.createByUserId).toBe('alice-id');
            expect(back.data?.organizer?.userId).toBe('alice-id');
            expect(back.data?.organizerEventId).toBe('org-evt-1');
            expect(back.data?.color).toBe('#ff8800');
            expect(back.createdAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
            expect(back.updatedAt?.toISOString()).toBe('2026-02-03T04:05:06.000Z');
            expect(back.sequence).toBe(3);

            const overrideBack = events.find((e) => e.recurrenceDate === '2026-04-22')!;
            expect(overrideBack.eventId).toBe('evt-override');
            expect(overrideBack.status).toBe('confirmed');

            const exclusionBack = events.find((e) => e.recurrenceDate === '2026-04-29')!;
            expect(exclusionBack.eventId).toBe('evt-exclusion');
            expect(exclusionBack.sequence).toBe(5);
            expect(exclusionBack.status).toBe('cancelled');
        });

        test(`${name} is idempotent on a second pass`, () => {
            const override = { ...OVERRIDE, allDay: master.allDay, timezone: master.timezone };
            const exclusion = { ...EXCLUSION, allDay: master.allDay, timezone: master.timezone };
            const once = serializeResource(buildResource([master, override, exclusion]));
            const twice = parse(once);
            restampResource(twice, parse(once));
            expect(serializeResource(twice)).toBe(once);
        });
    }

    test('a floating client VEVENT keeps its floating DTSTART through a re-stamp', () => {
        const floating = [
            'BEGIN:VEVENT',
            'UID:floating@client',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Floating',
            'DTSTART:20260415T120000',
            'DTEND:20260415T130000',
            'END:VEVENT',
        ];
        const incoming = parse(vcal(floating));
        restampResource(incoming, null);
        expect(serializeResource(incoming)).toContain('DTSTART:20260415T120000');
    });
});

describe('structural edits', () => {
    test('addExclusion writes an EXDATE with its stamp and drops the override of that key', () => {
        const resource = buildResource([MASTER, OVERRIDE]);
        expect(overridesOf(resource)).toHaveLength(1);

        addExclusion(resource, MASTER, { ...EXCLUSION, id: 'evt-cancel', recurrenceDate: '2026-04-22' }, CTX);

        expect(overridesOf(resource)).toHaveLength(0);
        const stamp = masterOf(resource).getAllProperties('x-eigen-exdate')[0];
        expect(stamp.getFirstValue()).toBe('2026-04-22');
        expect(stamp.getFirstParameter('x-eigen-event-id')).toBe('evt-cancel');
        expect(String(masterOf(resource).getFirstPropertyValue('last-modified'))).toBe('2026-06-01T10:00:00Z');
    });

    test('removeExclusion drops the EXDATE value and its stamp', () => {
        const resource = buildResource([MASTER, EXCLUSION]);
        removeExclusion(resource, '2026-04-29', CTX);

        expect(masterOf(resource).getAllProperties('exdate')).toHaveLength(0);
        expect(masterOf(resource).getAllProperties('x-eigen-exdate')).toHaveLength(0);
    });

    test('putOverride replaces an existing override of the same key', () => {
        const resource = buildResource([MASTER, OVERRIDE]);
        putOverride(resource, MASTER, { ...OVERRIDE, id: 'evt-override-2', title: 'Second take' });

        const overrides = overridesOf(resource);
        expect(overrides).toHaveLength(1);
        expect(overrides[0].getFirstPropertyValue('summary')).toBe('Second take');
        expect(overrides[0].getFirstPropertyValue('x-eigen-event-id')).toBe('evt-override-2');
    });
});

describe('stripping', () => {
    test('strip leaves no X-EIGEN substring and changes nothing else', () => {
        const withStamps = buildResource([MASTER, OVERRIDE, EXCLUSION]);
        const stripped = parse(serializeResource(withStamps));
        stripEigenStamps(stripped);
        const ics = serializeResource(stripped);
        expect(ics).not.toContain('X-EIGEN');

        // Everything but Eigen's own lines is jCal-equal to the stamped resource.
        const bare = snapshot(masterOf(parse(serializeResource(withStamps))));
        for (const name of Object.keys(bare)) {
            if (name.startsWith('x-eigen-')) continue;
            expect(JSON.stringify(snapshot(masterOf(stripped))[name])).toBe(JSON.stringify(bare[name]));
        }
        expect(masterOf(stripped).getAllProperties('exdate')).toHaveLength(1);
    });

    test('the outbound iMIP body carries no X-EIGEN line', () => {
        for (const method of ['REQUEST', 'REPLY', 'CANCEL'] as const) {
            expect(serializeEventForImip(MASTER, method)).not.toContain('X-EIGEN');
        }
    });

    test('CalDAV GET keeps the stamps that only the owner clients see', () => {
        expect(eventsToIcs([MASTER, OVERRIDE, EXCLUSION])).toContain('X-EIGEN-EVENT-ID:evt-master');
    });
});

describe('hasUnindexedRecurrence', () => {
    const flagged = (ics: string): boolean => projectResource(parseResource(ics)).hasUnindexedRecurrence;
    const series = (...extra: string[]) => [
        'BEGIN:VEVENT',
        'UID:flagged@client',
        'DTSTAMP:20260101T000000Z',
        'SUMMARY:Flagged',
        'DTSTART:20260415T100000Z',
        'DTEND:20260415T110000Z',
        ...extra,
        'END:VEVENT',
    ];

    test('true for a sub-daily rule', () => {
        expect(flagged(vcal(series('RRULE:FREQ=HOURLY;COUNT=4')))).toBe(true);
    });

    test('true for an out-of-range recurrence start', () => {
        const ancient = [
            'BEGIN:VEVENT',
            'UID:ancient@client',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Ancient',
            'DTSTART:10000101T090000Z',
            'DTEND:10000101T100000Z',
            'RRULE:FREQ=DAILY',
            'END:VEVENT',
        ];
        expect(flagged(vcal(ancient))).toBe(true);
    });

    test('true for an RDATE', () => {
        expect(flagged(vcal(series('RDATE:20260501T100000Z')))).toBe(true);
    });

    test('false for a plain weekly rule', () => {
        expect(flagged(vcal(series('RRULE:FREQ=WEEKLY;COUNT=4')))).toBe(false);
    });
});
