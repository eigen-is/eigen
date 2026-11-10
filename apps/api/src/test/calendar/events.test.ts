import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Calendar } from '../../lib/calendar/calendar';
import {
    CALENDAR_TEST_ROOT,
    defaultCalendarId,
    makeCalendar,
    putResource,
    resourceRowOf,
    resourceTextOf,
    storedEvents,
    vevent,
} from '../calendar-test-helpers';
import { breakTransaction } from '../db-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The event writes that re-home a stored resource. See docs/CALENDAR.md § Every write takes one lock and one function.

beforeAll(() => {
    rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
});

describe('a patch that changes nothing', () => {
    // A client's own spelling, which a rewrite through the store must not get a chance to disturb.
    const CLIENT_LINES = [
        'DURATION:PT1H',
        'X-CLIENT;X-P="a b":kept',
        'ATTENDEE;PARTSTAT=TENTATIVE;ROLE=REQ-PARTICIPANT:mailto:g@example.com',
    ];
    const stored = async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const calendar = harness.instance;
        const body = vcal([
            'BEGIN:VEVENT',
            'UID:same',
            'DTSTART:20260401T100000Z',
            'SUMMARY:Same',
            ...CLIENT_LINES,
            'END:VEVENT',
        ]);
        await putResource(calendar, calendarId, 'same.ics', body);
        const event = storedEvents(calendar, calendarId)[0];
        return { calendar, calendarId, event, ctag: (await calendar.getCollection(calendarId))?.ctag };
    };

    test('a save restating the stored event leaves the row and the bytes alone', async () => {
        const { calendar, calendarId, event, ctag } = await stored();
        const row = resourceRowOf(calendar, calendarId, 'same.ics');

        const saved = await calendar.updateEvent(calendarId, event.id, {
            title: event.title,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            timezone: event.timezone,
            data: event.data,
        });

        expect(saved.etag).toBe(event.etag);
        expect((await calendar.getCollection(calendarId))?.ctag).toBe(ctag);
        expect(resourceRowOf(calendar, calendarId, 'same.ics').ics).toEqual(row.ics);
    });

    test('an answer the guest already gave moves no ctag', async () => {
        const { calendar, calendarId, event, ctag } = await stored();

        await calendar.receiveAttendeeStatus(event.id, 'g@example.com', 'tentative');

        expect((await calendar.getCollection(calendarId))?.ctag).toBe(ctag);
        expect(storedEvents(calendar, calendarId)[0].etag).toBe(event.etag);
    });
});

describe("the first web save of a client's event", () => {
    const GUEST = 'guest@example.com';
    const AMSTERDAM = [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Amsterdam',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'DTSTART:19961027T030000',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'DTSTART:19810329T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
    ];
    // Each as the client writes it: the parameters and spellings Eigen's form can't restate are the point.
    const CLIENT_EVENTS = (owner: string): Record<string, string[]> => ({
        outlook: [
            `ATTENDEE;CN="Guest One";RSVP=TRUE:mailto:${GUEST}`,
            'DESCRIPTION;LANGUAGE=en-us:Agenda\\n',
            'DTSTART;TZID="W. Europe Standard Time":20261110T100000',
            'DTEND;TZID="W. Europe Standard Time":20261110T110000',
            'LOCATION;LANGUAGE=en-us:Room 1',
            `ORGANIZER;CN="The Owner":mailto:${owner}`,
            'SUMMARY;LANGUAGE=en-us:Standup',
            'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
        ],
        exchange: [
            `ORGANIZER;CN=The Owner:MAILTO:${owner}`,
            `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Guest One:MAILTO:${GUEST}`,
            'SUMMARY;LANGUAGE=en-US:Standup',
            'DTSTART:20261110T090000Z',
            'DTEND:20261110T100000Z',
            'STATUS:CONFIRMED',
        ],
        thunderbird: [
            'SUMMARY:Standup',
            `ORGANIZER;RSVP=FALSE;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${owner}`,
            `ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${GUEST}`,
            'DTSTART;TZID=Europe/Amsterdam:20261110T100000',
            'DTEND;TZID=Europe/Amsterdam:20261110T110000',
            'X-MOZ-GENERATION:1',
        ],
        apple: [
            `ATTENDEE;CN="The Owner";CUTYPE=INDIVIDUAL;EMAIL="${owner}";PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${owner}`,
            `ATTENDEE;CN="${GUEST}";CUTYPE=INDIVIDUAL;EMAIL="${GUEST}";RSVP=TRUE;SCHEDULE-STATUS=1.2:mailto:${GUEST}`,
            'DTSTART;TZID=Europe/Amsterdam:20261110T100000',
            'DTEND;TZID=Europe/Amsterdam:20261110T110000',
            `ORGANIZER;CN="The Owner";EMAIL="${owner}";SCHEDULE-AGENT=NONE:mailto:${owner}`,
            'RRULE:FREQ=WEEKLY;INTERVAL=1',
            'SUMMARY:Standup',
            'URL;VALUE=URI:https://example.com/agenda',
        ],
        google: [
            'DTSTART:20261110T090000Z',
            'DTEND:20261110T100000Z',
            `ORGANIZER;CN=${owner}:mailto:${owner}`,
            `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${GUEST};X-NUM-GUESTS=0:mailto:${GUEST}`,
            'DESCRIPTION:',
            'LOCATION:',
            'STATUS:CONFIRMED',
            'SUMMARY:Standup',
        ],
    });
    const stored = async (client: string) => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const calendar = harness.instance;
        const body = ['BEGIN:VEVENT', 'UID:client', ...CLIENT_EVENTS(harness.user.email)[client], 'END:VEVENT'];
        await putResource(calendar, calendarId, 'client.ics', vcal(AMSTERDAM, body));
        return { calendar, calendarId, event: storedEvents(calendar, calendarId)[0] };
    };

    for (const client of ['outlook', 'exchange', 'thunderbird', 'apple', 'google']) {
        test(`${client}'s bytes stay when the form restates what it read`, async () => {
            const { calendar, calendarId, event } = await stored(client);
            const before = await resourceTextOf(calendar, calendarId, 'client.ics');

            const saved = await calendar.updateEvent(calendarId, event.id, {
                title: event.title,
                description: event.description,
                location: event.location,
                startTime: event.startTime,
                endTime: event.endTime,
                allDay: event.allDay,
                timezone: event.timezone,
                rrule: event.rrule,
                data: event.data,
            });

            expect(await resourceTextOf(calendar, calendarId, 'client.ics')).toBe(before);
            expect(saved.etag).toBe(event.etag);
        });
    }

    test('an edit rewrites what it changes and leaves the parameters beside it', async () => {
        const { calendar, calendarId, event } = await stored('outlook');

        await calendar.updateEvent(calendarId, event.id, { title: 'Retro', location: event.location });

        const text = await resourceTextOf(calendar, calendarId, 'client.ics');
        expect(text).toContain('SUMMARY:Retro');
        expect(text).toContain('LOCATION;LANGUAGE=en-us:Room 1');
    });

    test('a guest answer moves their PARTSTAT and no other parameter', async () => {
        const { calendar, calendarId, event } = await stored('thunderbird');

        await calendar.receiveAttendeeStatus(event.id, GUEST, 'accepted');

        const text = (await resourceTextOf(calendar, calendarId, 'client.ics')).replaceAll('\r\n ', '');
        expect(text).toContain(`ATTENDEE;RSVP=TRUE;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:${GUEST}`);
        expect(text).toContain(';RSVP=FALSE;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:');
    });

    test('the same wall clock in another zone is another time, so the TZID still counts', async () => {
        const { calendar, calendarId, event } = await stored('thunderbird');

        await calendar.updateEvent(calendarId, event.id, { timezone: 'Europe/Paris' });

        const text = await resourceTextOf(calendar, calendarId, 'client.ics');
        expect(text).toContain('DTSTART;TZID=Europe/Paris:20261110T100000');
    });
});

// A client may store one occurrence of a series alone. Its UTC RECURRENCE-ID keys through its own DTSTART's zone, so
// the row and every edit of the file name one date, here 13 January.
describe('a lone occurrence a client wrote', () => {
    const stored = async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const calendar = harness.instance;
        const body = vcal([
            'BEGIN:VEVENT',
            'UID:lone',
            'DTSTAMP:20260101T000000Z',
            'RECURRENCE-ID:20260112T233000Z',
            'DTSTART;TZID=Europe/Amsterdam:20260113T013000',
            'DTEND;TZID=Europe/Amsterdam:20260113T023000',
            'SUMMARY:Lone',
            'END:VEVENT',
        ]);
        await putResource(calendar, calendarId, 'lone.ics', body);
        const event = storedEvents(calendar, calendarId)[0];
        expect(event.recurrenceDate).toBe('2026-01-13');
        return { calendar, calendarId, event };
    };

    test('a web save renames it', async () => {
        const { calendar, calendarId, event } = await stored();

        await calendar.updateEvent(calendarId, event.id, { title: 'Renamed' });

        expect(storedEvents(calendar, calendarId).map((e) => e.title)).toEqual(['Renamed']);
    });

    test('deleting it takes the file with it', async () => {
        const { calendar, calendarId, event } = await stored();

        await calendar.deleteEvent(calendarId, event.id);

        expect(await calendar.listResources(calendarId)).toHaveLength(0);
    });
});

describe('moveEvent', () => {
    const seriesOf = async (harness: TestHome<Calendar>, calendarId: string, uid: string, uri: string) => {
        await putResource(harness.instance, calendarId, uri, vcal(vevent(uid, 'Movable')));
        return storedEvents(harness.instance, calendarId).find((e) => e.uid === uid)!;
    };

    test('the blob and its rows re-home together, under the same ids', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-1@eigen', 'movable.ics');
        const bytes = await harness.instance.size();

        const after = await harness.instance.moveEvent(source, moved.id, target);

        expect(after.id).toBe(moved.id);
        expect(after.calendarId).toBe(target);
        expect(await harness.instance.listResources(source)).toHaveLength(0);
        expect((await harness.instance.listResources(target)).map((r) => r.uri)).toEqual(['movable.ics']);
        expect(await resourceTextOf(harness.instance, target, 'movable.ics')).toContain('SUMMARY:Movable');
        // Nothing was written or removed, so the counter cannot have moved.
        expect(await harness.instance.size()).toBe(bytes);
        // The source lists the uri as gone exactly once, and the target never as both.
        expect((await harness.instance.getDeletedResourcesSince(source, 0)).map((d) => d.uri)).toEqual(['movable.ics']);
        expect(await harness.instance.getDeletedResourcesSince(target, 0)).toEqual([]);
    });

    test('a target that already holds the UID refuses the move', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-2@eigen', 'a.ics');
        await putResource(harness.instance, target, 'b.ics', vcal(vevent('move-2@eigen', 'Twin')));

        await expect(harness.instance.moveEvent(source, moved.id, target)).rejects.toThrow(
            'The target calendar already holds this event',
        );
        expect((await harness.instance.listResources(source)).map((r) => r.uri)).toEqual(['a.ics']);
    });

    test('a name the target already uses becomes a fresh one', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-3@eigen', 'taken.ics');
        await putResource(harness.instance, target, 'taken.ics', vcal(vevent('other@eigen', 'Already there')));

        await harness.instance.moveEvent(source, moved.id, target);

        const names = (await harness.instance.listResources(target)).map((r) => r.uri).sort();
        expect(names).toHaveLength(2);
        expect(names).toContain('taken.ics');
        expect(await harness.instance.listResources(source)).toHaveLength(0);
        // The one the target already held keeps its own bytes.
        expect(await resourceTextOf(harness.instance, target, 'taken.ics')).toContain('SUMMARY:Already there');
    });

    test('a uri the target holds only as a tombstone is free, and the move drops that removal', async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const target = (await harness.instance.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        await putResource(harness.instance, target, 'reused.ics', vcal(vevent('reused@eigen', 'Removed later')));
        await harness.instance.deleteResource(target, 'reused.ics', { ifMatch: null });
        const moved = await seriesOf(harness, source, 'move-4@eigen', 'reused.ics');

        await harness.instance.moveEvent(source, moved.id, target);

        // The name is free, so the move keeps it — and the stale removal is dropped with the write.
        expect((await harness.instance.listResources(target)).map((r) => r.uri)).toEqual(['reused.ics']);
        expect(await harness.instance.getDeletedResourcesSince(target, 0)).toEqual([]);
    });

    test('a move whose transaction throws leaves both calendars as they were', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const source = await defaultCalendarId(harness);
        const target = (await calendar.createCalendar({ name: 'Target', color: '#2563eb' })).id;
        const moved = await seriesOf(harness, source, 'move-5@eigen', 'rolled-back.ics');
        const before = resourceRowOf(calendar, source, 'rolled-back.ics');
        const sourceCtag = (await calendar.getCollection(source))!.ctag;
        const targetCtag = (await calendar.getCollection(target))!.ctag;

        const restore = breakTransaction(calendar);
        try {
            await expect(calendar.moveEvent(source, moved.id, target)).rejects.toThrow('transaction boom');
        } finally {
            restore();
        }

        expect(resourceRowOf(calendar, source, 'rolled-back.ics')).toEqual(before);
        expect(await calendar.listResources(target)).toHaveLength(0);
        expect((await calendar.getCollection(source))!.ctag).toBe(sourceCtag);
        expect((await calendar.getCollection(target))!.ctag).toBe(targetCtag);
        expect(await calendar.getDeletedResourcesSince(source, 0)).toEqual([]);
    });
});
