// The ical.js component seam: build a VCALENDAR from rows, patch one VEVENT in place, re-stamp an
// untrusted body against the stored resource, strip Eigen's own lines. Fidelity is judged as jCal
// equality per property — ical.js rewrites `X-ADDRESS="a\nb"` to `a^nb`, drops a default `VALUE=URI`,
// reorders parameters and escapes a bare `;`, so a byte assert fails on the first run and a
// name-present assert passes on a mangled parameter.
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type ICAL from 'ical.js';
import {
    applyEdits,
    buildResource,
    parseIcs,
    parseResource,
    patchEvent,
    projectResource,
    restampResource,
    serializeEventForImip,
    serializeResource,
    storedRecurrenceIds,
} from '../../lib/ical';
import type { WriteContext } from '../../lib/ical/ical-component';
import { cpuClock } from '../cpu-time';
import { vcal } from '../ics-test-helpers';

const CTX = { now: new Date('2026-06-01T10:00:00Z'), actorIsOrganizer: true };

// One override edit, the way the store adds an occurrence it did not hold.
const putOverride = (resource: ICAL.Component, override: CalendarEvent, ctx: WriteContext = CTX): boolean =>
    applyEdits(resource, new Map([[override.recurrenceDate, { kind: 'override', event: override, ctx }]]));

// One exclusion edit, the way the store cancels an occurrence.
const exclude = (resource: ICAL.Component, exclusion: CalendarEvent, ctx: WriteContext = CTX): boolean =>
    applyEdits(resource, new Map([[exclusion.recurrenceDate, { kind: 'exclusion', id: exclusion.id, ctx }]]));

const masterOf = (resource: ICAL.Component): ICAL.Component =>
    resource.getAllSubcomponents('vevent').find((v) => !v.getFirstProperty('recurrence-id'))!;
const overridesOf = (resource: ICAL.Component): ICAL.Component[] =>
    resource.getAllSubcomponents('vevent').filter((v) => v.getFirstProperty('recurrence-id'));
const tzidsOf = (resource: ICAL.Component): string[] =>
    resource.getAllSubcomponents('vtimezone').map((v) => String(v.getFirstPropertyValue('tzid')));

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

// The series a client PUTs back: the same UID, summary, zone and rule Eigen's own rows project to, plus
// whatever shape the case under test hangs on it.
const clientSeries = (...extra: string[]) => [
    'BEGIN:VEVENT',
    'UID:series@eigen',
    'DTSTAMP:20260101T000000Z',
    'SUMMARY:Weekly sync',
    'SEQUENCE:3',
    'DTSTART;TZID=Europe/Amsterdam:20260415T120000',
    'DTEND;TZID=Europe/Amsterdam:20260415T130000',
    'RRULE:FREQ=WEEKLY;COUNT=8',
    ...extra,
    'END:VEVENT',
];

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
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink' }, CTX);

        expect(changedProperties(before, masterOf(resource))).toEqual(['dtstamp', 'last-modified', 'summary']);
        expect(masterOf(resource).getFirstPropertyValue('summary')).toBe('Renamed sink');
    });

    test('a title patch leaves the override untouched', () => {
        const before = overridesOf(parseResource(KITCHEN_SINK))[0];
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink' }, CTX);

        expect(changedProperties(before, overridesOf(resource)[0])).toEqual([]);
    });

    test('patching one attendee status changes only that ATTENDEE property', () => {
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
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
        expect(room.toJSON()).toEqual(before.getAllProperties('attendee')[1].toJSON());
    });

    test('removing an attendee drops that property and keeps the other whole', () => {
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            { data: { attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'pending', role: 'required' }] } },
            CTX,
        );

        const attendees = masterOf(resource).getAllProperties('attendee');
        expect(attendees).toHaveLength(1);
        expect(attendees[0].toJSON()).toEqual(before.getAllProperties('attendee')[0].toJSON());
    });

    test('an address the client listed twice has every one of its properties updated', () => {
        const resource = parseResource(
            vcal(VTZ_AMS, [
                ...KITCHEN_MASTER.slice(0, -1),
                'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Bob:mailto:BOB@x.com',
                'END:VEVENT',
            ]),
        );
        patchEvent(
            resource,
            null,
            { data: { attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'accepted', role: 'required' }] } },
            CTX,
        );

        const partstats = masterOf(resource)
            .getAllProperties('attendee')
            .map((a) => a.getFirstParameter('partstat'));
        expect(partstats).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    test('a null rrule in the patch does not remove the sub-daily RRULE', () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink', rrule: null }, CTX);

        expect(String(masterOf(resource).getFirstPropertyValue('rrule'))).toBe('FREQ=HOURLY;COUNT=10');
    });

    test('an unchanged reminder list does not touch the AUDIO alarm', () => {
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
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
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, { data: { reminders: [{ type: 'notification', minutes: 5 }] } }, CTX);

        const alarms = masterOf(resource).getAllSubcomponents('valarm');
        expect(alarms).toHaveLength(1);
        expect(alarms[0].getFirstPropertyValue('action')).toBe('DISPLAY');
        expect(String(alarms[0].getFirstPropertyValue('trigger'))).toBe('-PT5M');
    });

    test('patching the override addresses it by recurrence key', () => {
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, '2026-04-22', { title: 'Override renamed' }, CTX);

        expect(overridesOf(resource)[0].getFirstPropertyValue('summary')).toBe('Override renamed');
        expect(changedProperties(before, masterOf(resource))).toEqual([]);
    });

    test('an unchanged title writes nothing at all', () => {
        const before = masterOf(parseResource(KITCHEN_SINK));
        const resource = parseResource(KITCHEN_SINK);
        expect(patchEvent(resource, null, { title: before.getFirstPropertyValue('summary') as string }, CTX)).toBe(
            false,
        );
        expect(changedProperties(before, masterOf(resource))).toEqual([]);
    });
});

describe('SEQUENCE', () => {
    const timesPatch = { startTime: new Date('2026-04-15T14:00:00Z'), endTime: new Date('2026-04-15T15:00:00Z') };
    const guest = { ...CTX, actorIsOrganizer: false };
    const sequenceOf = (vevent: ICAL.Component) => Number(vevent.getFirstPropertyValue('sequence'));
    // The series at SEQUENCE 3, a moved date at 6, and a cancelled one stamped 5.
    const highWater = () => {
        const resource = parseResource(serializeResource(buildResource([MASTER, { ...OVERRIDE, sequence: 6 }])));
        exclude(resource, EXCLUSION, { ...guest, sequence: 5 });
        return resource;
    };

    test("an organizer's scheduling change takes the file's highest SEQUENCE plus one", () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, timesPatch, CTX);
        expect(sequenceOf(masterOf(resource))).toBe(3);

        const moved = highWater();
        patchEvent(moved, null, timesPatch, CTX);
        expect(sequenceOf(masterOf(moved))).toBe(7);
    });

    test('an event with no attendees takes the raised number too', () => {
        const resource = parseResource(vcal(VTZ_AMS, KITCHEN_MASTER));
        masterOf(resource).removeAllProperties('attendee');
        patchEvent(resource, null, timesPatch, CTX);
        expect(sequenceOf(masterOf(resource))).toBe(3);
    });

    test("an organizer's new date that reschedules, and a cancelled one, outrank every revision the file holds", () => {
        const added = highWater();
        putOverride(added, { ...OVERRIDE, id: 'evt-new', recurrenceDate: '2026-05-06', sequence: 0 });
        expect(
            sequenceOf(overridesOf(added).find((v) => v.getFirstPropertyValue('x-eigen-event-id') === 'evt-new')!),
        ).toBe(7);

        const cancelled = highWater();
        exclude(cancelled, { ...EXCLUSION, id: 'evt-gone', recurrenceDate: '2026-05-06' });
        const stamp = masterOf(cancelled)
            .getAllProperties('x-eigen-exdate')
            .find((prop) => prop.getFirstValue() === '2026-05-06')!;
        expect(stamp.getFirstParameter('x-eigen-seq')).toBe('7');
        expect(stamp.getFirstParameter('x-eigen-dtstamp')).toBe('20260601T100000Z');
        expect(sequenceOf(masterOf(cancelled))).toBe(7);
    });

    // An attendee copy mirrors the organizer's revision instead of computing one: the RFC 5546 replay guard compares
    // the stored number against the next message's.
    test('a receiver never raises: a date it adds mirrors what it holds for that date, else the series', () => {
        const resource = highWater();
        putOverride(resource, { ...OVERRIDE, id: 'evt-own', recurrenceDate: '2026-04-29' }, guest);
        putOverride(resource, { ...OVERRIDE, id: 'evt-fresh', recurrenceDate: '2026-05-06' }, guest);
        const byId = (id: string) =>
            overridesOf(resource).find((v) => v.getFirstPropertyValue('x-eigen-event-id') === id)!;
        expect(sequenceOf(byId('evt-own'))).toBe(5);
        expect(sequenceOf(byId('evt-fresh'))).toBe(3);

        patchEvent(resource, null, timesPatch, guest);
        expect(sequenceOf(masterOf(resource))).toBe(3);
        exclude(resource, { ...EXCLUSION, id: 'evt-mine', recurrenceDate: '2026-05-13' }, guest);
        expect(sequenceOf(masterOf(resource))).toBe(3);
    });

    test('a stated sequence is written as given, whatever the organizer rule would say', () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, timesPatch, { ...guest, sequence: 9 });
        expect(sequenceOf(masterOf(resource))).toBe(9);
        patchEvent(
            resource,
            null,
            { ...timesPatch, startTime: new Date('2026-04-15T16:00:00Z') },
            { ...CTX, sequence: 4 },
        );
        expect(sequenceOf(masterOf(resource))).toBe(4);
    });

    test('a stated sequence alone is a change worth writing', () => {
        const resource = parseResource(KITCHEN_SINK);
        expect(patchEvent(resource, null, {}, { ...guest, sequence: 7 })).toBe(true);
        expect(sequenceOf(masterOf(resource))).toBe(7);
    });

    test('does not raise for a change that is not scheduling-significant', () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, null, { title: 'Renamed sink', location: 'Room 9' }, CTX);
        expect(sequenceOf(masterOf(resource))).toBe(2);

        patchEvent(resource, null, { description: null }, CTX);
        expect(sequenceOf(masterOf(resource))).toBe(2);
    });

    test('raises on an attendee-set change and never moves CREATED', () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(
            resource,
            null,
            { data: { attendees: [{ email: 'bob@x.com', name: 'Bob', status: 'pending', role: 'required' }] } },
            CTX,
        );
        expect(sequenceOf(masterOf(resource))).toBe(3);
        expect(String(masterOf(resource).getFirstPropertyValue('created'))).toBe('2025-12-01T09:00:00Z');
    });
});

describe('clearing a field', () => {
    const series = (...extra: string[]) => parseResource(vcal(VTZ_AMS, clientSeries(...extra)));
    const FILLED = ['DESCRIPTION:Agenda', 'LOCATION:Room 9', 'URL:https://example.com/a', 'X-EIGEN-COLOR:#ff0000'];

    test.each([
        ['description', { description: null }],
        ['location', { location: null }],
        ['url', { data: { url: '' } }],
        ['x-eigen-color', { data: { color: '' } }],
    ])('clearing only %s counts as a change and touches the revision', (name, patch) => {
        const resource = series(...FILLED);

        expect(patchEvent(resource, null, patch, CTX)).toBe(true);

        const master = masterOf(resource);
        expect(master.getFirstProperty(name)).toBeNull();
        expect(String(master.getFirstPropertyValue('last-modified'))).toBe('2026-06-01T10:00:00Z');
        expect(String(master.getFirstPropertyValue('dtstamp'))).toBe('2026-06-01T10:00:00Z');
    });

    test('a guest copy mirrors the organizer sequence alongside a cleared field', () => {
        const resource = series(...FILLED);
        const guest = { ...CTX, actorIsOrganizer: false, sequence: 3 };

        expect(patchEvent(resource, null, { location: null }, guest)).toBe(true);

        expect(masterOf(resource).getFirstProperty('location')).toBeNull();
        expect(String(masterOf(resource).getFirstPropertyValue('last-modified'))).toBe('2026-06-01T10:00:00Z');
    });

    test('dropping a DURATION that sat beside a DTEND counts as a change', () => {
        const resource = series('DURATION:PT1H');
        const startTime = new Date('2026-04-15T10:00:00Z');

        expect(patchEvent(resource, null, { startTime }, CTX)).toBe(true);

        expect(masterOf(resource).getFirstProperty('duration')).toBeNull();
        expect(masterOf(resource).getFirstProperty('last-modified')).not.toBeNull();
    });

    test('clearing what is already absent, or restating a value, changes nothing', () => {
        const absent = series();
        const before = serializeResource(absent);
        const patch = { description: null, location: '', data: { url: '', color: '' } };
        expect(patchEvent(absent, null, patch, CTX)).toBe(false);
        expect(serializeResource(absent)).toBe(before);

        const filled = series(...FILLED);
        const restated = { description: 'Agenda', location: 'Room 9' };
        expect(patchEvent(filled, null, restated, { ...CTX, sequence: 3 })).toBe(false);
        expect(masterOf(filled).getFirstProperty('last-modified')).toBeNull();
    });
});

describe('stamp trust', () => {
    const stored = () => parseResource(serializeResource(buildResource([MASTER, OVERRIDE, EXCLUSION])));

    // A client that rewrote every EXDATE into the UTC-Z comma-joined form and forged Eigen's own lines.
    const forged = clientSeries(
        'EXDATE:20260429T100000Z',
        'ORGANIZER;CN=Alice:mailto:alice@eigen.example',
        'X-EIGEN-EVENT-ID:forged-id',
        'X-EIGEN-CREATED-BY:mallory',
        'X-EIGEN-ORGANIZER-EVENT:forged-org-event',
        'X-EIGEN-ORGANIZER-USER:mallory',
        'X-EIGEN-COLOR:#000000',
        'X-EIGEN-IMPORTED-ORGANIZER:mallory@evil.example',
        'X-EIGEN-EXDATE;X-EIGEN-EVENT-ID=forged-exc;X-EIGEN-SEQ=99:2026-04-29',
        'DTSTART;X-EIGEN-EVENT-ID=forged-param:20260415T100000Z',
    );

    test('the untrusted entry reads no stamp the body carries', () => {
        const { events } = parseIcs(vcal(VTZ_AMS, forged));
        const [master, exclusion] = events;

        expect(master.data?.organizer?.userId).toBeUndefined();
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

    test('one occurrence excluded in several forms is one cancelled row', () => {
        const repeated = clientSeries(
            'EXDATE:20260429T100000Z,20260429T100000Z',
            'EXDATE;TZID=Europe/Amsterdam:20260429T120000',
            'X-EIGEN-EXDATE;X-EIGEN-EVENT-ID=evt-exclusion;X-EIGEN-SEQ=5:2026-04-29',
        );

        expect(parseIcs(vcal(VTZ_AMS, repeated)).events.filter((e) => e.status === 'cancelled')).toHaveLength(1);
        const cancelled = projectResource(parseResource(vcal(VTZ_AMS, repeated))).events.filter(
            (e) => e.status === 'cancelled',
        );
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0].eventId).toBe('evt-exclusion');
    });

    test('the trusted projection of the same bytes reads every stamp', () => {
        const { events } = projectResource(parseResource(vcal(VTZ_AMS, forged)));
        const [master, exclusion] = events;

        expect(master.eventId).toBe('forged-id');
        expect(master.createByUserId).toBe('mallory');
        expect(master.data?.organizer?.userId).toBe('mallory');
        expect(master.data?.organizerEventId).toBe('forged-org-event');
        expect(master.data?.color).toBe('#000000');
        expect(master.importedOrganizer).toBe('mallory@evil.example');
        expect(exclusion.eventId).toBe('forged-exc');
        expect(exclusion.sequence).toBe(99);
    });

    test('every forged stamp is discarded and the stored one comes back', () => {
        const incoming = parseResource(vcal(VTZ_AMS, forged));
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
        const incoming = parseResource(vcal(VTZ_AMS, forged));
        restampResource(incoming, stored());
        expect(serializeResource(incoming)).not.toContain('forged-param');
    });

    // vCard-style property groups: `A.X-EIGEN-EVENT-ID` is the same property under a label, and ical.js
    // keeps the group in the name.
    test('a grouped X-EIGEN property and parameter are discarded too', () => {
        const incoming = parseResource(
            vcal(
                VTZ_AMS,
                clientSeries('A.X-EIGEN-EVENT-ID:pwned', 'DTEND;B.X-EIGEN-ORGANIZER-USER=pwned:20260415T130000Z'),
            ),
        );
        restampResource(incoming, stored());
        expect(serializeResource(incoming)).not.toContain('pwned');

        const fresh = parseResource(vcal(VTZ_AMS, clientSeries('A.X-EIGEN-EVENT-ID:pwned')));
        restampResource(fresh, null);
        expect(serializeResource(fresh)).not.toContain('pwned');
    });

    test('the imported organizer rides across a PUT like every other server-owned line', () => {
        const storedImport = parseResource(vcal(VTZ_AMS, clientSeries('X-EIGEN-IMPORTED-ORGANIZER:ada@external.com')));
        const incoming = parseResource(vcal(VTZ_AMS, clientSeries()));
        restampResource(incoming, storedImport);

        expect(masterOf(incoming).getFirstPropertyValue('x-eigen-imported-organizer')).toBe('ada@external.com');
        expect(projectResource(incoming).events[0].importedOrganizer).toBe('ada@external.com');
    });

    test('two VEVENTs that key alike never share one stored id', () => {
        const twins = parseResource(
            vcal(VTZ_AMS, clientSeries('EXDATE:20260429T100000Z'), clientSeries('EXDATE:20260429T100000Z')),
        );
        restampResource(twins, stored());

        const ids = twins.getAllSubcomponents('vevent').map((v) => v.getFirstPropertyValue('x-eigen-event-id'));
        expect(new Set(ids).size).toBe(ids.length);
        const exclusionIds = twins
            .getAllSubcomponents('vevent')
            .flatMap((v) => v.getAllProperties('x-eigen-exdate').map((s) => s.getFirstParameter('x-eigen-event-id')));
        expect(exclusionIds).toHaveLength(2);
        expect(new Set(exclusionIds).size).toBe(2);
    });

    test('two overrides of one occurrence in two date forms never share one stored id', () => {
        const override = (recurrenceId: string) => [
            'BEGIN:VEVENT',
            'UID:series@eigen',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Weekly sync (moved)',
            `RECURRENCE-ID;${recurrenceId}`,
            'DTSTART;TZID=Europe/Amsterdam:20260422T140000',
            'DTEND;TZID=Europe/Amsterdam:20260422T150000',
            'END:VEVENT',
        ];
        const incoming = parseResource(
            vcal(
                VTZ_AMS,
                clientSeries(),
                override('TZID=Europe/Amsterdam:20260422T120000'),
                override('VALUE=DATE-TIME:20260422T100000Z'),
            ),
        );
        restampResource(incoming, stored());

        const ids = overridesOf(incoming).map((v) => v.getFirstPropertyValue('x-eigen-event-id'));
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
        expect(ids).toContain('evt-override');
    });

    test('a body carrying twenty thousand EXDATEs re-stamps in under a second and a half', () => {
        const exdates: string[] = [];
        for (let day = 0; day < 20_000; day++) {
            const when = new Date(Date.UTC(2026, 3, 29) + day * 86400_000);
            exdates.push(`EXDATE:${when.toISOString().replace(/[-:]|\.\d{3}/g, '')}`);
            exdates.push(`X-EIGEN-EXDATE;X-EIGEN-EVENT-ID=exc-${day};X-EIGEN-SEQ=1:${when.toISOString().slice(0, 10)}`);
        }
        const incoming = parseResource(vcal(VTZ_AMS, clientSeries(...exdates)));

        const cpuMs = cpuClock();
        restampResource(incoming, stored());
        expect(cpuMs()).toBeLessThan(1500);
        expect(masterOf(incoming).getAllProperties('x-eigen-exdate')).toHaveLength(20_000);
    });

    test('thirty-two thousand EXDATEs with no SEQUENCE re-stamp without rescanning the properties per stamp', () => {
        const count = 32_000;
        const padding = 128_000;
        const days = Array.from({ length: count }, (_, day) =>
            new Date(Date.UTC(2026, 3, 29) + day * 86400_000).toISOString(),
        );
        const incoming = parseResource(
            vcal([
                'BEGIN:VEVENT',
                'UID:series@eigen',
                'DTSTAMP:20260101T000000Z',
                'DTSTART:20260415T120000Z',
                ...Array<string>(padding).fill('X-PAD:p'),
                ...days.map((iso) => `EXDATE:${iso.replace(/[-:]|\.\d{3}/g, '')}`),
                'END:VEVENT',
            ]),
        );

        const cpuMs = cpuClock();
        restampResource(incoming, null);
        expect(cpuMs()).toBeLessThan(700);

        const master = masterOf(incoming);
        expect(master.getAllProperties().map((prop) => prop.name)).toEqual([
            'uid',
            'dtstamp',
            'dtstart',
            ...Array<string>(padding).fill('x-pad'),
            ...Array<string>(count).fill('exdate'),
            'x-eigen-event-id',
            ...Array<string>(count).fill('x-eigen-exdate'),
        ]);
        const stamps = master.getAllProperties('x-eigen-exdate');
        expect(stamps.map((stamp) => stamp.getFirstValue())).toEqual(days.map((iso) => iso.slice(0, 10)));
        expect(stamps.every((stamp) => stamp.getFirstParameter('x-eigen-seq') === '0')).toBe(true);
        expect(new Set(stamps.map((stamp) => stamp.getFirstParameter('x-eigen-event-id'))).size).toBe(count);
    });

    test('forty thousand twins of one key read a huge stored VEVENT once, and only the first keeps its id', () => {
        const twins = 40_000;
        const stamps = [
            'X-EIGEN-EVENT-ID:stored-id',
            'X-EIGEN-CREATED-BY:maker',
            'X-EIGEN-ORGANIZER-EVENT:org-event',
            'X-EIGEN-ORGANIZER-USER:org-user',
            'X-EIGEN-COLOR:#ff0000',
            'X-EIGEN-IMPORTED-ORGANIZER:boss@example.com',
        ];
        const stored = parseResource(
            vcal(['BEGIN:VEVENT', 'UID:twin@eigen', ...Array<string>(16_000).fill('X-PAD:p'), ...stamps, 'END:VEVENT']),
        );
        const twin = ['BEGIN:VEVENT', 'UID:twin@eigen', 'DTSTAMP:20260101T000000Z', 'END:VEVENT'];
        const incoming = parseResource(vcal(Array.from({ length: twins }, () => twin).flat()));

        const cpuMs = cpuClock();
        restampResource(incoming, stored);
        expect(cpuMs()).toBeLessThan(2000);

        const lines = (vevent: ICAL.Component) => vevent.getAllProperties().map((prop) => prop.toICALString());
        const vevents = incoming.getAllSubcomponents('vevent');
        expect(lines(vevents[0]).slice(2)).toEqual(stamps);
        for (const vevent of vevents.slice(1)) {
            expect(lines(vevent).slice(3)).toEqual(stamps.slice(1));
        }
        const ids = vevents.map((vevent) => vevent.getFirstPropertyValue('x-eigen-event-id'));
        expect(new Set(ids).size).toBe(twins);
    });

    test('a body that stripped every X- line gets its ids and links back', () => {
        const lines = serializeResource(buildResource([MASTER, OVERRIDE, EXCLUSION]))
            .replace(/\r\n[ \t]/g, '')
            .split('\r\n');
        const bare = parseResource(lines.filter((line) => !line.startsWith('X-EIGEN')).join('\r\n'));
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
        const incoming = parseResource(vcal(VTZ_AMS, clientSeries('EXDATE:20260429T100000Z,20260506T100000Z')));
        restampResource(incoming, parseResource(serializeResource(twoExclusions)));

        const stamps = masterOf(incoming).getAllProperties('x-eigen-exdate');
        expect(stamps.map((s) => [s.getFirstValue(), s.getFirstParameter('x-eigen-event-id')])).toEqual([
            ['2026-04-29', 'evt-exclusion'],
            ['2026-05-06', 'evt-exclusion-2'],
        ]);
    });

    test('an EXDATE the client added gets a fresh id and the master sequence', () => {
        const incoming = parseResource(
            vcal(
                VTZ_AMS,
                clientSeries(
                    'EXDATE;TZID=Europe/Amsterdam:20260429T120000',
                    'EXDATE;TZID=Europe/Amsterdam:20260513T120000',
                ),
            ),
        );
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
        const incoming = parseResource(vcal(VTZ_AMS, clientSeries()));
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
        const storedAllDay = parseResource(serializeResource(buildResource([allDayMaster, allDayExclusion])));
        expect(masterOf(storedAllDay).getFirstProperty('exdate')!.toJSON()).toEqual([
            'exdate',
            {},
            'date',
            '2026-04-29',
        ]);

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
        const incoming = parseResource(vcal(client));
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
        const storedJunk = parseResource(vcal(VTZ_AMS, junk));
        const incoming = parseResource(vcal(VTZ_AMS, junk));
        restampResource(incoming, storedJunk);

        const stamp = masterOf(incoming).getAllProperties('x-eigen-exdate')[0];
        expect(stamp.getFirstValue()).toBe('2026-04-29');
        expect(stamp.getFirstParameter('x-eigen-event-id')).toMatch(/^[0-9a-f-]{36}$/);
        expect(stamp.getFirstParameter('x-eigen-seq')).toBe('0');

        expect(projectResource(storedJunk).events[1].sequence).toBe(0);
    });

    test('with no stored resource everything is minted and only trusted organizer stamps are set', () => {
        const incoming = parseResource(vcal(VTZ_AMS, forged));
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
        const incoming = parseResource(vcal(VTZ_AMS, forged));
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
            const twice = parseResource(once);
            restampResource(twice, parseResource(once));
            expect(serializeResource(twice)).toBe(once);
        });
    }

    // RFC 5545 §3.8.4.4: RECURRENCE-ID takes the master DTSTART's value type, whatever the override's own.
    describe('an override toggled across all-day', () => {
        const timedMaster: CalendarEvent = {
            ...MASTER,
            startTime: new Date('2026-09-27T22:30:00Z'), // Mon 28 Sep 00:30 Amsterdam
            endTime: new Date('2026-09-27T23:30:00Z'),
        };
        const allDayMaster: CalendarEvent = {
            ...MASTER,
            allDay: true,
            startTime: new Date('2026-09-28T00:00:00Z'),
            endTime: new Date('2026-09-29T00:00:00Z'),
        };

        test('an all-day override of a timed series names the master DATE-TIME in its TZID', () => {
            const override: CalendarEvent = {
                ...OVERRIDE,
                parentEventId: timedMaster.id,
                recurrenceDate: '2026-10-05',
                allDay: true,
                startTime: new Date('2026-10-05T00:00:00Z'),
                endTime: new Date('2026-10-06T00:00:00Z'),
            };
            const ics = serializeResource(buildResource([timedMaster, override]));

            expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20261005T003000');
            expect(ics).toContain('DTSTART;VALUE=DATE:20261005');
            const back = parseIcs(ics).events.find((e) => e.recurrenceDate)!;
            expect(back.recurrenceDate).toBe('2026-10-05');
            expect(back.allDay).toBe(true);
        });

        test('a timed override of an all-day series names the master DATE', () => {
            const override: CalendarEvent = {
                ...OVERRIDE,
                parentEventId: allDayMaster.id,
                recurrenceDate: '2026-10-05',
                allDay: false,
                startTime: new Date('2026-10-05T08:00:00Z'),
                endTime: new Date('2026-10-05T09:00:00Z'),
            };
            const ics = serializeResource(buildResource([allDayMaster, override]));

            expect(ics).toContain('RECURRENCE-ID;VALUE=DATE:20261005');
            expect(ics).toContain('DTSTART;TZID=Europe/Amsterdam:20261005T100000');
            const back = parseIcs(ics).events.find((e) => e.recurrenceDate)!;
            expect(back.recurrenceDate).toBe('2026-10-05');
            expect(back.allDay).toBe(false);
            expect(back.startTime.toISOString()).toBe('2026-10-05T08:00:00.000Z');
        });
    });

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
        const incoming = parseResource(vcal(floating));
        restampResource(incoming, null);
        expect(masterOf(incoming).getFirstProperty('dtstart')!.toJSON()).toEqual([
            'dtstart',
            {},
            'date-time',
            '2026-04-15T12:00:00',
        ]);
    });
});

describe('storedRecurrenceIds', () => {
    const date = (recurrenceId: string, start: string) => [
        'BEGIN:VEVENT',
        'UID:lone',
        'DTSTAMP:20260101T000000Z',
        `RECURRENCE-ID${recurrenceId}`,
        `DTSTART${start}`,
        'SUMMARY:One date',
        'END:VEVENT',
    ];

    test('reads every occurrence of a file under its key, its RECURRENCE-ID as the organizer wrote it', () => {
        const resource = parseResource(
            vcal(
                date(';TZID=America/New_York:20260505T170000', ';TZID=Europe/Amsterdam:20260505T230000'),
                date(':20260507T090000Z', ';TZID=Pacific/Auckland:20260507T210000'),
                date(':20260509T090000', ':20260509T090000'),
            ),
        );

        expect(storedRecurrenceIds(resource)).toEqual(
            new Map([
                ['2026-05-05', { instant: new Date('2026-05-05T21:00:00Z'), timezone: 'America/New_York' }],
                ['2026-05-07', { instant: new Date('2026-05-07T09:00:00Z'), timezone: null }],
                ['2026-05-09', null],
            ]),
        );
    });

    test('a series holds its master under null, which names no occurrence', () => {
        const resource = buildResource([MASTER, OVERRIDE]);

        expect(storedRecurrenceIds(resource)).toEqual(
            new Map([
                [null, null],
                ['2026-04-22', { instant: new Date('2026-04-22T10:00:00Z'), timezone: 'Europe/Amsterdam' }],
            ]),
        );
    });
});

describe('a RECURRENCE-ID from its occurrence key', () => {
    const series = (rrule: string, startTime: Date): CalendarEvent => ({
        ...MASTER,
        rrule,
        startTime,
        endTime: new Date(startTime.getTime() + 3600_000),
    });
    const override = (key: string): CalendarEvent => ({ ...OVERRIDE, id: `o-${key}`, recurrenceDate: key });

    test('a rule that states its hour keys each day to that hour, either side of a DST change', () => {
        // DTSTART is 09:00 in Amsterdam, and the clocks go forward on 29 March.
        const master = series('FREQ=DAILY;BYHOUR=17', new Date('2026-03-23T08:00:00Z'));
        const ics = serializeResource(buildResource([master, override('2026-03-27'), override('2026-03-30')]));

        expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260327T170000');
        expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T170000');
    });

    test("a midnight series keys a day off its rule to that day's midnight, not the next one's", () => {
        // Mondays at 00:00 in Amsterdam, and 19 April is the Sunday before one.
        const master = series('FREQ=WEEKLY;BYDAY=MO', new Date('2026-04-12T22:00:00Z'));
        const ics = serializeResource(buildResource([master, override('2026-04-19')]));

        expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260419T000000');
    });

    test('a daily series with a thousand exceptions builds at little cost', () => {
        const keys = Array.from({ length: 1000 }, (_, i) =>
            new Date(Date.UTC(2026, 3, 16 + i)).toISOString().slice(0, 10),
        );
        const exceptions = keys.map((key, i) =>
            i % 3 === 2 ? { ...EXCLUSION, id: `x-${key}`, recurrenceDate: key } : override(key),
        );

        const cpuMs = cpuClock();
        const resource = buildResource([series('FREQ=DAILY', MASTER.startTime), ...exceptions]);
        expect(cpuMs()).toBeLessThan(1000);

        expect(overridesOf(resource)).toHaveLength(667);
    });
});

describe('timezone fidelity', () => {
    const zoned = (start: string, end: string) => [
        'BEGIN:VEVENT',
        'UID:zoned@client',
        'DTSTAMP:20260101T000000Z',
        'SUMMARY:Zoned',
        `DTSTART;TZID=Europe/Amsterdam:${start}`,
        `DTEND;TZID=Europe/Amsterdam:${end}`,
        'END:VEVENT',
    ];
    const single = (start: Date, end: Date): CalendarEvent => ({
        ...MASTER,
        rrule: null,
        data: null,
        startTime: start,
        endTime: end,
    });
    const startOf = (ics: string): string => parseIcs(ics).events[0].startTime.toISOString();

    test('a client zone named UTC gets a VTIMEZONE under that name when the event moves', () => {
        const resource = parseResource(
            vcal([
                'BEGIN:VEVENT',
                'UID:utc@client',
                'DTSTAMP:20260101T000000Z',
                'DTSTART;TZID=UTC:20260601T100000',
                'DTEND;TZID=UTC:20260601T110000',
                'END:VEVENT',
            ]),
        );
        const moved = { startTime: new Date('2026-06-02T10:00:00Z'), endTime: new Date('2026-06-02T11:00:00Z') };
        patchEvent(resource, null, moved, CTX);

        expect(resource.getAllSubcomponents('vtimezone').map((zone) => zone.getFirstPropertyValue('tzid'))).toEqual([
            'UTC',
        ]);
        expect(parseIcs(serializeResource(resource)).events[0].timezone).toBe('UTC');
    });

    test('an ambiguous wall time names the same instant with and without a VTIMEZONE', () => {
        const lines = zoned('20261025T023000', '20261025T033000');
        // RFC 5545 resolves the repeated hour to its first pass, which is what the builder writes.
        expect(startOf(vcal(VTZ_AMS, lines))).toBe('2026-10-25T00:30:00.000Z');
        expect(startOf(vcal(lines))).toBe('2026-10-25T00:30:00.000Z');
    });

    test('a row ending in the second pass through the repeated hour round-trips exactly', () => {
        const [back] = parseIcs(
            serializeResource(
                buildResource([single(new Date('2026-10-25T00:30:00Z'), new Date('2026-10-25T01:30:00Z'))]),
            ),
        ).events;

        expect(back.startTime.toISOString()).toBe('2026-10-25T00:30:00.000Z');
        expect(back.endTime.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    });

    test('a start in the spring-forward gap reads as a real instant and settles on the second pass', () => {
        const [first] = parseIcs(vcal(VTZ_AMS, zoned('20260329T023000', '20260329T033000'))).events;
        expect(Number.isNaN(first.startTime.getTime())).toBe(false);

        const rebuilt = serializeResource(
            buildResource([single(first.startTime, new Date(first.startTime.getTime() + 3600_000))]),
        );
        expect(startOf(rebuilt)).toBe(first.startTime.toISOString());
    });

    test('a TZID Intl rejects still resolves through the VTIMEZONE the file carries', () => {
        const vtzCustom = [
            'BEGIN:VTIMEZONE',
            'TZID:Customer Standard Time',
            'BEGIN:STANDARD',
            'DTSTART:19700101T000000',
            'TZOFFSETFROM:+0500',
            'TZOFFSETTO:+0500',
            'END:STANDARD',
            'END:VTIMEZONE',
        ];
        const custom = [
            'BEGIN:VEVENT',
            'UID:custom@client',
            'DTSTAMP:20260101T000000Z',
            'SUMMARY:Custom zone',
            'DTSTART;TZID=Customer Standard Time:20260415T120000',
            'DTEND;TZID=Customer Standard Time:20260415T130000',
            'END:VEVENT',
        ];

        expect(startOf(vcal(vtzCustom, custom))).toBe('2026-04-15T07:00:00.000Z');
    });

    test('a timezone patch brings the VTIMEZONE it needs and drops the one nothing names', () => {
        const resource = buildResource([{ ...MASTER, data: null }]);
        expect(tzidsOf(resource)).toEqual(['Europe/Amsterdam']);

        patchEvent(resource, null, { timezone: 'America/New_York' }, CTX);

        expect(tzidsOf(resource)).toEqual(['America/New_York']);
        expect(parseIcs(serializeResource(resource)).events[0].startTime.toISOString()).toBe(
            MASTER.startTime.toISOString(),
        );
    });

    test('a VTIMEZONE another property still names stays, definition untouched', () => {
        const resource = parseResource(KITCHEN_SINK);
        const before = resource.getAllSubcomponents('vtimezone')[0].toJSON();

        patchEvent(resource, '2026-04-22', { timezone: 'America/New_York' }, CTX);

        expect(tzidsOf(resource).sort()).toEqual(['America/New_York', 'Europe/Amsterdam']);
        const kept = resource
            .getAllSubcomponents('vtimezone')
            .find((v) => String(v.getFirstPropertyValue('tzid')) === 'Europe/Amsterdam')!;
        expect(kept.toJSON()).toEqual(before);
    });

    // A client reads the file top to bottom: a TZID it has not met yet is a floating wall time to it.
    test('a VTIMEZONE a patch brings precedes every VEVENT', () => {
        const resource = parseResource(KITCHEN_SINK);
        patchEvent(resource, '2026-04-22', { timezone: 'America/New_York' }, CTX);

        const text = serializeResource(resource);
        expect(text.lastIndexOf('BEGIN:VTIMEZONE')).toBeLessThan(text.indexOf('BEGIN:VEVENT'));
    });

    test('an override in a zone the file does not define brings its VTIMEZONE', () => {
        const resource = parseResource(vcal(VTZ_AMS, clientSeries()));
        const before = resource.getAllSubcomponents('vtimezone')[0].toJSON();

        putOverride(resource, { ...OVERRIDE, timezone: 'America/New_York' });

        expect(tzidsOf(resource).sort()).toEqual(['America/New_York', 'Europe/Amsterdam']);
        const kept = resource
            .getAllSubcomponents('vtimezone')
            .find((v) => String(v.getFirstPropertyValue('tzid')) === 'Europe/Amsterdam')!;
        expect(kept.toJSON()).toEqual(before);
    });

    test("an EXDATE names the master's own zone, and brings the VTIMEZONE the file lacks", () => {
        const resource = parseResource(vcal(clientSeries()));

        exclude(resource, { ...EXCLUSION, recurrenceDate: '2026-04-22' });

        expect(serializeResource(resource)).toContain('EXDATE;TZID=Europe/Amsterdam:20260422T120000\r\n');
        expect(tzidsOf(resource)).toEqual(['Europe/Amsterdam']);
    });
});

describe('the outbound iMIP body', () => {
    test('carries no VALARM, whatever the method', () => {
        for (const method of ['REQUEST', 'REPLY', 'CANCEL'] as const) {
            expect(serializeEventForImip(MASTER, method)).not.toContain('BEGIN:VALARM');
        }
    });

    // An ACTION:EMAIL alarm names its own ATTENDEE, so every guest's client would mail the organizer.
    test('never ships an email reminder as an alarm naming the organizer', () => {
        const body = serializeEventForImip(
            { ...MASTER, data: { ...MASTER.data, reminders: [{ type: 'email', minutes: 10 }] } },
            'REQUEST',
        );

        expect(body).not.toContain('BEGIN:VALARM');
        expect(body).not.toContain('ACTION:EMAIL');
    });

    test('a REQUEST asks the guests to reply and rides the organizer along as accepted', () => {
        const vevent = parseResource(serializeEventForImip(MASTER, 'REQUEST')).getAllSubcomponents('vevent')[0];
        const byAddress = new Map(
            vevent.getAllProperties('attendee').map((a) => [String(a.getFirstValue()).toLowerCase(), a]),
        );

        expect(byAddress.get('mailto:bob@x.com')!.getFirstParameter('rsvp')).toBe('TRUE');
        expect(byAddress.get('mailto:bob@x.com')!.getFirstParameter('partstat')).toBe('NEEDS-ACTION');
        expect(byAddress.get('mailto:alice@eigen.example')!.getFirstParameter('partstat')).toBe('ACCEPTED');
        expect(byAddress.get('mailto:alice@eigen.example')!.getFirstParameter('rsvp')).toBeUndefined();
        expect(vevent.getFirstPropertyValue('url')).toBe('https://example.com/meeting');
    });

    // A body for one occurrence names the instance in the SERIES' zone, so it has to define that zone —
    // an exception of its own carries none.
    test('an occurrence body defines the zone its RECURRENCE-ID names', () => {
        const resource = parseResource(serializeEventForImip({ ...OVERRIDE, timezone: null }, 'REQUEST', MASTER));

        const recurrenceId = overridesOf(resource)[0].getFirstProperty('recurrence-id')!;
        expect(recurrenceId.getFirstParameter('tzid')).toBe('Europe/Amsterdam');
        expect(tzidsOf(resource)).toContain('Europe/Amsterdam');
    });

    test('a REPLY asks nobody to reply', () => {
        const vevent = parseResource(serializeEventForImip(MASTER, 'REPLY')).getAllSubcomponents('vevent')[0];
        for (const attendee of vevent.getAllProperties('attendee')) {
            expect(attendee.getFirstParameter('rsvp')).toBeUndefined();
        }
    });
});

describe('structural edits', () => {
    test('an exclusion writes an EXDATE with its stamp and drops the override of that key', () => {
        const resource = buildResource([MASTER, OVERRIDE]);
        expect(overridesOf(resource)).toHaveLength(1);

        exclude(resource, { ...EXCLUSION, id: 'evt-cancel', recurrenceDate: '2026-04-22' });

        expect(overridesOf(resource)).toHaveLength(0);
        const stamp = masterOf(resource).getAllProperties('x-eigen-exdate')[0];
        expect(stamp.getFirstValue()).toBe('2026-04-22');
        expect(stamp.getFirstParameter('x-eigen-event-id')).toBe('evt-cancel');
        expect(String(masterOf(resource).getFirstPropertyValue('last-modified'))).toBe('2026-06-01T10:00:00Z');
    });

    test('cancelling one occurrence twice leaves one EXDATE and one stamp', () => {
        const resource = buildResource([MASTER]);
        exclude(resource, { ...EXCLUSION, id: 'evt-cancel-1', recurrenceDate: '2026-04-22' });
        exclude(resource, { ...EXCLUSION, id: 'evt-cancel-2', recurrenceDate: '2026-04-22' });

        const master = masterOf(resource);
        expect(master.getAllProperties('exdate').flatMap((p) => p.getValues())).toHaveLength(1);
        const stamps = master.getAllProperties('x-eigen-exdate');
        expect(stamps).toHaveLength(1);
        expect(stamps[0].getFirstParameter('x-eigen-event-id')).toBe('evt-cancel-2');
    });

    // Re-instating a cancelled occurrence: an EXDATE left beside the new override would keep the
    // occurrence excluded and project a second, cancelled row for the same key.
    test('putOverride drops the exclusion of the key it overrides', () => {
        const resource = buildResource([MASTER, EXCLUSION]);
        putOverride(resource, { ...OVERRIDE, recurrenceDate: EXCLUSION.recurrenceDate });

        const master = masterOf(resource);
        expect(master.getAllProperties('exdate')).toHaveLength(0);
        expect(master.getAllProperties('x-eigen-exdate')).toHaveLength(0);
        expect(
            projectResource(resource).events.filter((e) => e.recurrenceDate === EXCLUSION.recurrenceDate),
        ).toHaveLength(1);
    });

    // A copy of single dates has no master to carry an EXDATE: the excluded date's VEVENT goes and nothing else.
    test('an exclusion on a resource with no master VEVENT drops that date alone', () => {
        const resource = parseResource(serializeResource(buildResource([OVERRIDE])));
        exclude(resource, OVERRIDE);
        expect(resource.getAllSubcomponents('vevent')).toHaveLength(0);
    });

    test('putOverride replaces an existing override of the same key', () => {
        const resource = buildResource([MASTER, OVERRIDE]);
        putOverride(resource, { ...OVERRIDE, id: 'evt-override-2', title: 'Second take' });

        const overrides = overridesOf(resource);
        expect(overrides).toHaveLength(1);
        expect(overrides[0].getFirstPropertyValue('summary')).toBe('Second take');
        expect(overrides[0].getFirstPropertyValue('x-eigen-event-id')).toBe('evt-override-2');
    });
});

// A structural edit names a VEVENT the resource has to hold. A caller handing over a row the file
// cannot place — an occurrence nothing overrides, a row that names no occurrence, an override-only
// body — is a bug in the store, not a resource to rewrite.
describe('refusals', () => {
    const unkeyed = { ...OVERRIDE, recurrenceDate: null };

    test('patchEvent refuses an occurrence the resource does not hold', () => {
        expect(() => patchEvent(buildResource([MASTER]), '2026-05-20', { title: 'x' }, CTX)).toThrow(
            'the resource holds no VEVENT for 2026-05-20',
        );
    });

    test('putOverride refuses an override that names no occurrence', () => {
        expect(() => putOverride(buildResource([MASTER]), unkeyed)).toThrow('names no occurrence');
    });

    test('an exclusion refuses an exclusion that names no occurrence', () => {
        expect(() => exclude(buildResource([MASTER]), unkeyed)).toThrow('names no occurrence');
    });
});

describe('stripping', () => {
    test('sixty-four thousand forged stamp names go in one pass and the rest keep their order', () => {
        const forged = Array.from({ length: 64_000 }, (_, n) => `X-EIGEN-${n}:forged`);
        const incoming = parseResource(
            vcal(
                VTZ_AMS,
                clientSeries(
                    'X-KEEP-FIRST:a',
                    ...forged.slice(0, 32_000),
                    'ATTENDEE;X-EIGEN-SEQ=9;CN=Bob:mailto:bob@eigen.example',
                    ...forged.slice(32_000),
                    'X-KEEP-LAST:z',
                ),
            ),
        );

        const cpuMs = cpuClock();
        restampResource(incoming, null);
        expect(cpuMs()).toBeLessThan(250);

        const expected = [
            'uid',
            'dtstamp',
            'summary',
            'sequence',
            'dtstart',
            'dtend',
            'rrule',
            'x-keep-first',
            'attendee',
            'x-keep-last',
            'x-eigen-event-id',
        ];
        const names = (resource: ICAL.Component) =>
            masterOf(resource)
                .getAllProperties()
                .map((prop) => prop.name);
        expect(names(incoming)).toEqual(expected);
        expect(names(parseResource(serializeResource(incoming)))).toEqual(expected);
        expect(masterOf(incoming).getFirstProperty('attendee')?.toJSON()[1]).toEqual({ cn: 'Bob' });
    });

    test('a restamp drops every Eigen line a body carries and changes nothing else', () => {
        const withStamps = buildResource([MASTER, OVERRIDE, EXCLUSION]);
        const restamped = parseResource(serializeResource(withStamps));
        restampResource(restamped, null);
        expect(serializeResource(restamped)).not.toContain('#ff8800');
        expect(serializeResource(restamped)).not.toContain('evt-master');

        // Everything but Eigen's own lines is jCal-equal to the stamped resource.
        const bare = snapshot(masterOf(parseResource(serializeResource(withStamps))));
        for (const name of Object.keys(bare)) {
            if (name.startsWith('x-eigen-')) continue;
            expect(snapshot(masterOf(restamped))[name]).toEqual(bare[name]);
        }
        expect(masterOf(restamped).getAllProperties('exdate')).toHaveLength(1);
    });

    test('the outbound iMIP body carries no X-EIGEN line', () => {
        for (const method of ['REQUEST', 'REPLY', 'CANCEL'] as const) {
            expect(serializeEventForImip(MASTER, method)).not.toContain('X-EIGEN');
        }
    });

    test('CalDAV GET keeps the stamps that only the owner clients see', () => {
        const served = parseResource(serializeResource(buildResource([MASTER, OVERRIDE, EXCLUSION])));
        expect(masterOf(served).getFirstPropertyValue('x-eigen-event-id')).toBe('evt-master');
    });
});

describe('a removal costs one pass over the list', () => {
    const padding = (count: number) => Array<string>(count).fill('X-PAD:p');
    const emptyComponents = (name: string, count: number) => Array<string>(count).fill(`BEGIN:${name}\r\nEND:${name}`);
    const series = (...lines: string[]) => [
        'BEGIN:VEVENT',
        'UID:large@eigen',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260415T120000Z',
        'DTEND:20260415T130000Z',
        'SUMMARY:Large',
        'RRULE:FREQ=DAILY',
        ...lines,
        'END:VEVENT',
    ];
    const overrides = (count: number) =>
        Array.from({ length: count }, (_, day) => {
            const key = new Date(Date.UTC(2000, 0, 1) + day * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
            return `BEGIN:VEVENT\r\nUID:large@eigen\r\nRECURRENCE-ID:${key}T120000Z\r\nDTSTART:${key}T120000Z\r\nEND:VEVENT`;
        });
    const masterNames = (resource: ICAL.Component) =>
        masterOf(resource)
            .getAllProperties()
            .map((prop) => prop.name);

    test('a title save over repeated LAST-MODIFIED lines past a long first stretch', () => {
        const resource = parseResource(
            vcal([
                'BEGIN:VEVENT',
                'UID:large@eigen',
                'DTSTAMP:20260101T000000Z',
                ...padding(110_000),
                'DTSTART:20260415T120000Z',
                'SUMMARY:Large',
                ...Array<string>(60_000).fill('LAST-MODIFIED:20260101T000000Z'),
                ...padding(100_000),
                'END:VEVENT',
            ]),
        );

        const cpuMs = cpuClock();
        patchEvent(resource, null, { title: 'New' }, CTX);
        expect(cpuMs()).toBeLessThan(1_500);

        const names = masterNames(resource);
        expect(names.filter((name) => name === 'last-modified')).toHaveLength(1);
        expect(names.filter((name) => name === 'x-pad')).toHaveLength(210_000);
        expect(masterOf(resource).getFirstPropertyValue('summary')).toBe('New');
    });

    test('dropping every guest of a long list past a long padding', () => {
        const resource = parseResource(
            vcal(series(...padding(30_000), ...Array<string>(30_000).fill('ATTENDEE:mailto:a@b.c'), 'X-LAST:z')),
        );

        const cpuMs = cpuClock();
        patchEvent(resource, null, { data: { attendees: [] } }, CTX);
        expect(cpuMs()).toBeLessThan(800);

        const names = masterNames(resource);
        expect(names).not.toContain('attendee');
        expect(names.indexOf('x-last')).toBe(names.lastIndexOf('x-pad') + 1);
    });

    test('an override over an occurrence named by a long run of repeated EXDATEs', () => {
        const resource = parseResource(
            vcal(series(...padding(40_000), ...Array<string>(30_000).fill('EXDATE:20260420T120000Z'), 'X-LAST:z')),
        );

        const cpuMs = cpuClock();
        putOverride(resource, { ...OVERRIDE, uid: 'large@eigen', recurrenceDate: '2026-04-20', timezone: null });
        expect(cpuMs()).toBeLessThan(800);

        const names = masterNames(resource);
        expect(names).not.toContain('exdate');
        expect(names.indexOf('x-last')).toBe(names.lastIndexOf('x-pad') + 1);
    });

    test('a move drops a long run of unreferenced VTIMEZONEs behind many overrides', () => {
        const resource = parseResource(
            vcal(series(), overrides(15_000), emptyComponents('VTIMEZONE', 50_000), emptyComponents('X-LAST', 1)),
        );

        const cpuMs = cpuClock();
        patchEvent(resource, null, { startTime: new Date('2026-04-15T11:00:00Z') }, CTX);
        expect(cpuMs()).toBeLessThan(800);

        const names = resource.getAllSubcomponents().map((sub) => sub.name);
        expect(names).not.toContain('vtimezone');
        expect(names).toEqual([...Array<string>(15_001).fill('vevent'), 'x-last']);
    });

    test('a new zone moves a long run of overrides behind its block', () => {
        const resource = parseResource(vcal(emptyComponents('X-FIRST', 30_000), series(), overrides(6_000)));

        const cpuMs = cpuClock();
        patchEvent(resource, null, { startTime: new Date('2026-04-15T11:00:00Z'), timezone: 'Europe/Amsterdam' }, CTX);
        expect(cpuMs()).toBeLessThan(800);

        const names = resource.getAllSubcomponents().map((sub) => sub.name);
        expect(names).toEqual([
            ...Array<string>(30_000).fill('x-first'),
            'vtimezone',
            ...Array<string>(6_001).fill('vevent'),
        ]);
    });

    test('dropping a long run of alarms in front of other subcomponents', () => {
        const resource = parseResource(
            vcal(
                series(
                    ...emptyComponents('X-FIRST', 110_000),
                    ...emptyComponents('VALARM', 60_000),
                    ...emptyComponents('X-LAST', 60_000),
                ),
            ),
        );

        const cpuMs = cpuClock();
        patchEvent(resource, null, { data: { reminders: [] } }, CTX);
        expect(cpuMs()).toBeLessThan(800);

        const names = masterOf(resource)
            .getAllSubcomponents()
            .map((sub) => sub.name);
        expect(names).toEqual([...Array<string>(110_000).fill('x-first'), ...Array<string>(60_000).fill('x-last')]);
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
