import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Attendee } from '@workspace/lib/types/calendar';
import type { Calendar } from '../../lib/calendar/calendar';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { makeSyntheticUser } from '../../lib/user';
import { CALENDAR_TEST_ROOT, makeCalendar, receiveMailed, storedEvents } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';
import { findOrFail } from '../setup';

// The one decision an inbound iMIP REQUEST takes (L36): update the copy it is linked to, adopt an event
// this Home already holds when the verified sender is the organizer it names, or drop it — never a second
// master for one UID.

const ORG = 'organizer@external.com';
const OTHER = 'someone.else@external.com';
const UID = 'inbound-request@external.com';

const request = (extra: string[] = [], organizer = ORG, uid = UID): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'SUMMARY:Quarterly review',
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        'SEQUENCE:2',
        `ORGANIZER;CN=Ext Org:mailto:${organizer}`,
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@test.local',
        'DTSTAMP:20260101T000000Z',
        ...extra,
        'END:VEVENT',
    ]);

const parsedOf = (ics: string): ParsedEvent => parseIcs(ics).events[0];

// An event the Home already holds, written by its own client: an ORGANIZER address and no link.
const stored = (organizer: string | null, uid = UID): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'SUMMARY:Quarterly review (mine)',
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        ...(organizer ? [`ORGANIZER;CN=Ext Org:mailto:${organizer}`] : []),
        'DTSTAMP:20260101T000000Z',
        'END:VEVENT',
    ]);

async function harnessWith(body?: string): Promise<{ harness: TestHome<Calendar>; calendar: Calendar; id: string }> {
    const harness = await makeCalendar();
    const calendar = harness.instance;
    const id = (await calendar.getCalendars())[0].id;
    if (body) expect((await calendar.putResource(id, 'mine.ics', body, NO_PRECONDITIONS)).ok).toBe(true);
    return { harness, calendar, id };
}

const NO_PRECONDITIONS = { ifMatch: null, ifNoneMatch: null };

describe('inbound iMIP REQUEST', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('the organizer a stored event names adopts it in place', async () => {
        const { calendar, id } = await harnessWith(stored(ORG));
        const before = storedEvents(calendar, id)[0];

        await receiveMailed(calendar, parsedOf(request()), ORG);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        // Same row, same file: an adoption is a write of the resource the Home already had.
        expect(rows[0].id).toBe(before.id);
        expect(rows[0].uri).toBe('mine.ics');
        expect(rows[0].data?.organizerEventId).toBe(UID);
        expect(rows[0].data?.organizer?.userId).toBe(`external_${ORG}`);
        expect(rows[0].data?.attendees?.[0].email).toBe('owner@test.local');
        expect(rows[0].title).toBe('Quarterly review');
        expect(rows[0].sequence).toBe(2);
    });

    test('the address an imported event was filed under adopts it too', async () => {
        const harness = await makeCalendar();
        const id = (await harness.instance.getCalendars())[0].id;
        // Stage 7's import writes this stamp; the put seam does the same for an imported organizer.
        expect(
            (
                await harness.instance.putResource(id, 'imported.ics', stored(null), {
                    ...NO_PRECONDITIONS,
                    import: { organizer: ORG },
                })
            ).ok,
        ).toBe(true);

        await receiveMailed(harness.instance, parsedOf(request()), ORG);
        const rows = await harness.instance.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].uri).toBe('imported.ics');
        expect(rows[0].data?.organizerEventId).toBe(UID);
    });

    test('a sender the stored event does not name is dropped', async () => {
        const { calendar, id } = await harnessWith(stored(ORG));

        await receiveMailed(calendar, parsedOf(request([], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizerEventId).toBeUndefined();
        expect(rows[0].title).toBe('Quarterly review (mine)');
        expect(await calendar.listResources(id)).toHaveLength(1);
    });

    test('a REQUEST for a UID linked to another organizer is dropped', async () => {
        const { calendar } = await harnessWith();
        await receiveMailed(calendar, parsedOf(request()), ORG);

        // A co-attendee re-sending the same series must not take the invitation over.
        await receiveMailed(calendar, parsedOf(request(['SEQUENCE:9'], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizer?.email).toBe(ORG);
        expect(rows[0].sequence).toBe(2);
    });

    test('a body whose ORGANIZER is not the sender never becomes an invitation', async () => {
        const { calendar, id } = await harnessWith();

        await receiveMailed(calendar, parsedOf(request([], ORG)), OTHER);

        expect(await calendar.getEventsByUid(UID)).toHaveLength(0);
        expect(await calendar.listResources(id)).toHaveLength(0);
    });

    test('a REQUEST that cancels the whole series cancels the copy', async () => {
        const { calendar } = await harnessWith();
        await receiveMailed(calendar, parsedOf(request()), ORG);

        await receiveMailed(calendar, parsedOf(request(['STATUS:CANCELLED'])), ORG);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('cancelled');
    });

    test('a REQUEST that restores a cancelled series confirms the copy', async () => {
        const { calendar } = await harnessWith();
        await receiveMailed(calendar, parsedOf(request(['STATUS:CANCELLED'])), ORG);

        await receiveMailed(calendar, parsedOf(request(['STATUS:CONFIRMED'])), ORG);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('confirmed');
    });

    test('a REQUEST the store refuses for its size is dropped, not half-written', async () => {
        const { calendar, id } = await harnessWith();
        const huge = 'x'.repeat(6_000_000);

        await receiveMailed(calendar, parsedOf(request([`DESCRIPTION:${huge}`])), ORG);

        expect(await calendar.getEventsByUid(UID)).toHaveLength(0);
        expect(await calendar.listResources(id)).toHaveLength(0);
    });

    test('two concurrent deliveries of one REQUEST leave one resource', async () => {
        const { calendar, id } = await harnessWith();
        const parsed = parsedOf(request());

        await Promise.all([receiveMailed(calendar, parsed, ORG), receiveMailed(calendar, parsed, ORG)]);

        expect(await calendar.listResources(id)).toHaveLength(1);
        expect(await calendar.getEventsByUid(UID)).toHaveLength(1);
    });
});

// The relay carries the same REQUEST from one Eigen Home to another, so it takes the same decision: the
// link it vouches for is the organizer's Home rather than an address, and nothing else differs.
describe('relayed invitation', () => {
    const ORG_HOME = 'organizer-home-id';
    const ORG_EVENT = 'organizer-event-id';

    const LINK = {
        organizerEmail: ORG,
        organizerEventId: ORG_EVENT,
        organizerUserId: ORG_HOME,
        createByUserId: ORG_HOME,
    };
    const requested = (title = 'Quarterly review', sequence = 2, email = ORG): ParsedEvent => ({
        uid: UID,
        title,
        description: null,
        location: null,
        startTime: new Date('2026-05-01T09:00:00Z'),
        endTime: new Date('2026-05-01T10:00:00Z'),
        allDay: false,
        rrule: null,
        timezone: null,
        status: 'confirmed',
        sequence,
        dtstamp: new Date('2026-01-01T00:00:00Z'),
        recurrenceDate: null,
        recurrenceInstant: null,
        data: {
            organizer: { userId: ORG_HOME, email, name: 'Ext Org' },
            attendees: [{ email: 'owner@test.local', status: 'pending', role: 'required' }],
        },
    });

    test('a UID the Home holds in another calendar is never filed a second time', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const other = await calendar.createCalendar({ name: 'Work', color: '#aabbcc' });
        expect((await calendar.putResource(other.id, 'mine.ics', stored(null), NO_PRECONDITIONS)).ok).toBe(true);

        await calendar.receiveRequest([requested()], LINK);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizerEventId).toBeUndefined();
    });

    // The link is the organizer's Home and event, never an address, so only that Home updates the copy.
    test('an update applies by the link it names, whatever address it carries', async () => {
        const { calendar } = await harnessWith();
        await calendar.receiveRequest([requested()], LINK);

        await calendar.receiveRequest([requested('Renamed by the organizer', 3, 'organizer.alias@external.com')], {
            ...LINK,
            organizerEmail: 'organizer.alias@external.com',
        });
        await calendar.receiveRequest([requested('Renamed by a stranger', 4)], {
            ...LINK,
            organizerUserId: 'stranger',
        });

        expect((await calendar.getEventsByUid(UID)).map((row) => row.title)).toEqual(['Renamed by the organizer']);
    });

    // A Home is never its own organizer. Adopting such a payload would turn its own event into a linked
    // copy of itself, after which every CalDAV PUT on it is reduced to alarms — the hole the iMIP
    // transport already closes on its own sender.
    test('a payload naming this Home as the organizer is dropped', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const id = (await calendar.getCalendars())[0].id;
        expect((await calendar.putResource(id, 'mine.ics', stored(harness.user.email), NO_PRECONDITIONS)).ok).toBe(
            true,
        );

        await calendar.receiveRequest([requested('Quarterly review', 2, harness.user.email)], {
            ...LINK,
            organizerEmail: harness.user.email,
            organizerUserId: harness.user.id,
            createByUserId: harness.user.id,
        });

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizerEventId).toBeUndefined();
        expect(rows[0].title).toBe('Quarterly review (mine)');
    });

    // An organizer's client restates WHEN the event is in every message, so a REQUEST that moved nothing
    // must leave the stored bounds exactly as they came — a DURATION is not a DTEND.
    test('a REQUEST that moves nothing leaves the stored DURATION alone', async () => {
        const duration = vcal([
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Quarterly review (mine)',
            'DTSTART:20260501T090000Z',
            'DURATION:PT1H',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ]);
        const { calendar, id } = await harnessWith(duration);

        await receiveMailed(calendar, parsedOf(request()), ORG);

        const row = (await calendar.getEventsByUid(UID))[0];
        expect(row.data?.organizerEventId).toBe(UID);
        expect(row.title).toBe('Quarterly review');
        const body = await calendar.getResource(id, 'mine.ics');
        const ics = Buffer.from(body!.bytes).toString();
        expect(ics).toContain('DURATION:PT1H');
        expect(ics).not.toContain('DTEND');
    });

    // A file may list its override before its master, so the linked lookup takes the master or a series
    // update would find an exception and read as "an occurrence copy the series now replaces".
    test('a series REQUEST updates the linked series whose file lists its override first', async () => {
        const overrideFirst = `${vcal(
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Moved occurrence',
                'RECURRENCE-ID:20260502T090000Z',
                'DTSTART:20260502T110000Z',
                'DTEND:20260502T120000Z',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ],
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:The series',
                'DTSTART:20260501T090000Z',
                'DTEND:20260501T100000Z',
                'RRULE:FREQ=DAILY;COUNT=5',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ],
        )}\r\n`;
        const { calendar } = await harnessWith(overrideFirst);
        // The first REQUEST adopts the series in place, which links it; the second finds it by that link.
        await receiveMailed(calendar, parsedOf(request(['RRULE:FREQ=DAILY;COUNT=5'])), ORG);

        const series = request(['RRULE:FREQ=DAILY;COUNT=5'])
            .replace('SEQUENCE:2', 'SEQUENCE:3')
            .replace('SUMMARY:Quarterly review', 'SUMMARY:Renamed series');
        await receiveMailed(calendar, parsedOf(series), ORG);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows.find((r) => !r.parentEventId)?.title).toBe('Renamed series');
        expect(rows.find((r) => r.parentEventId)?.title).toBe('Moved occurrence');
    });

    test('the organizer an event in another calendar names adopts it in place', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const other = await calendar.createCalendar({ name: 'Work', color: '#aabbcc' });
        expect((await calendar.putResource(other.id, 'mine.ics', stored(ORG), NO_PRECONDITIONS)).ok).toBe(true);

        await calendar.receiveRequest([requested()], LINK);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].calendarId).toBe(other.id);
        expect(rows[0].data?.organizerEventId).toBe(ORG_EVENT);
        expect(rows[0].data?.organizer?.userId).toBe(ORG_HOME);
    });
});

// A REQUEST is one UID's events, decided and written once: a guest added to a series with many moved and cancelled
// occurrences is told once, and a redelivery of it writes nothing.
describe('one REQUEST, one write', () => {
    const LINK = {
        organizerEmail: ORG,
        organizerEventId: 'series-org-event',
        organizerUserId: 'series-org-home',
        createByUserId: 'series-org-home',
    };
    const START = Date.parse('2026-05-01T09:00:00Z');
    const DAY = 86_400_000;

    // A daily series and `n` of its occurrences: every third one cancelled, the others two hours later.
    function seriesRequest(guest: string, n: number, title = 'Standup', status: Attendee['status'] = 'pending') {
        const base = {
            uid: 'one-write@external.com',
            description: null,
            location: null,
            allDay: false,
            timezone: 'Europe/Amsterdam',
            sequence: 0,
            dtstamp: new Date('2026-04-01T10:00:00Z'),
            recurrenceInstant: null,
            data: {
                organizer: { userId: LINK.organizerUserId, email: ORG, name: 'Ext Org' },
                attendees: [{ email: guest, status, role: 'required' as const }],
            },
        };
        const master: ParsedEvent = {
            ...base,
            title,
            startTime: new Date(START),
            endTime: new Date(START + 3_600_000),
            rrule: 'FREQ=DAILY',
            status: 'confirmed',
            recurrenceDate: null,
        };
        const exceptions = Array.from({ length: n }, (_, i): ParsedEvent => {
            const day = START + (i + 1) * 2 * DAY;
            const cancelled = (i + 1) % 3 === 0;
            const shift = cancelled ? 0 : 7_200_000;
            return {
                ...base,
                title: cancelled ? title : `${title} moved ${i + 1}`,
                startTime: new Date(day + shift),
                endTime: new Date(day + 3_600_000 + shift),
                rrule: null,
                status: cancelled ? 'cancelled' : 'confirmed',
                recurrenceDate: new Date(day).toISOString().slice(0, 10),
            };
        });
        return [master, ...exceptions];
    }

    const ctagOf = async (calendar: Calendar, id: string) => (await calendar.getCalendarById(id))?.ctag;

    test('a guest added to a series with 30 exceptions gets one copy, one write and one notice', async () => {
        const { harness, calendar, id } = await harnessWith();
        const notify = spyOn(calendar.home, 'notify');
        const before = await ctagOf(calendar, id);
        const broadcasts = harness.broadcasts.length;

        await calendar.receiveRequest(seriesRequest(harness.user.email, 30), LINK);

        const rows = storedEvents(calendar, id);
        expect(rows).toHaveLength(31);
        expect(rows.filter((e) => e.status === 'cancelled')).toHaveLength(10);
        expect(rows.filter((e) => e.title.startsWith('Standup moved'))).toHaveLength(20);
        expect(await ctagOf(calendar, id)).toBe((before ?? 0) + 1);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0].type).toBe('calendar-invite');
        expect(harness.broadcasts).toHaveLength(broadcasts + 2);
    });

    test('a redelivery of that message moves no ctag and tells nobody', async () => {
        const { harness, calendar, id } = await harnessWith();
        await calendar.receiveRequest(seriesRequest(harness.user.email, 30), LINK);
        const notify = spyOn(calendar.home, 'notify');
        const before = await ctagOf(calendar, id);
        const broadcasts = harness.broadcasts.length;

        await calendar.receiveRequest(seriesRequest(harness.user.email, 30), LINK);

        expect(await ctagOf(calendar, id)).toBe(before);
        expect(notify).not.toHaveBeenCalled();
        expect(harness.broadcasts).toHaveLength(broadcasts);
    });

    // The organizer kept the occurrence's own title, which was the series' old one, and the file lists it first.
    test('a rename reaches the overrides before their own events patch them, and its redelivery writes nothing', async () => {
        const { harness, calendar, id } = await harnessWith();
        const [master, moved] = seriesRequest(harness.user.email, 1);
        const kept = { ...moved, title: 'Standup' };
        await calendar.receiveRequest([master, kept], LINK);
        const renamed = [kept, { ...master, title: 'Standup v2' }];

        await calendar.receiveRequest(renamed, LINK);
        const before = await ctagOf(calendar, id);
        await calendar.receiveRequest(renamed, LINK);

        const rows = storedEvents(calendar, id);
        expect(rows.find((e) => !e.parentEventId)?.title).toBe('Standup v2');
        expect(rows.find((e) => e.parentEventId)?.title).toBe('Standup');
        expect(await ctagOf(calendar, id)).toBe(before);
    });

    test('a master the store refuses files nothing, its occurrences included', async () => {
        const { harness, calendar, id } = await harnessWith();
        const [master, ...exceptions] = seriesRequest(harness.user.email, 3);

        await calendar.receiveRequest([{ ...master, description: 'x'.repeat(6_000_000) }, ...exceptions], LINK);

        expect(storedEvents(calendar, id)).toHaveLength(0);
    });

    test('a guest accepted answer survives adoption at an equal SEQUENCE', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const id = (await calendar.getCalendars())[0].id;
        const mine = vcal([
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Quarterly review (mine)',
            'DTSTART:20260501T090000Z',
            'DTEND:20260501T100000Z',
            'SEQUENCE:2',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${harness.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ]);
        expect((await calendar.putResource(id, 'mine.ics', mine, NO_PRECONDITIONS)).ok).toBe(true);

        await calendar.receiveRequest([parsedOf(request().replace('owner@test.local', harness.user.email))], {
            organizerEmail: ORG,
            organizerEventId: UID,
            organizerUserId: `external_${ORG}`,
            createByUserId: `external_${ORG}`,
        });

        const [adopted] = await calendar.getEventsByUid(UID);
        expect(adopted.data?.organizerEventId).toBe(UID);
        expect(adopted.data?.attendees?.find((a) => a.email === harness.user.email)?.status).toBe('accepted');
    });
});

// A guest's "delete this and following" cuts their copy's rule, and nothing of the series may outlive the cut.
describe('a guest who removes this and following', () => {
    const SERIES = 'cut@external.com';
    const series = (guest: string, title: string): ParsedEvent[] =>
        parseIcs(
            vcal([
                'BEGIN:VEVENT',
                `UID:${SERIES}`,
                `SUMMARY:${title}`,
                'RRULE:FREQ=DAILY;COUNT=10',
                'DTSTART:20260504T090000Z',
                'DTEND:20260504T093000Z',
                'EXDATE:20260508T090000Z',
                `ORGANIZER:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
                'BEGIN:VEVENT',
                `UID:${SERIES}`,
                `SUMMARY:${title} moved`,
                'RECURRENCE-ID:20260510T090000Z',
                'DTSTART:20260510T140000Z',
                'DTEND:20260510T143000Z',
                `ORGANIZER:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ]),
        ).events;

    test('keeps no moved or cancelled occurrence past the cut', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const link = {
            organizerEmail: ORG,
            organizerEventId: SERIES,
            organizerUserId: `external_${ORG}`,
            createByUserId: `external_${ORG}`,
        };
        await calendar.receiveRequest(series(harness.user.email, 'Standup'), link);
        const master = findOrFail(await calendar.getEventsByUid(SERIES), (e) => !e.parentEventId);

        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        await calendar.rsvp(master.id, me, {
            status: 'declined',
            scope: 'this-and-following',
            recurrenceDate: '2026-05-07',
            remove: true,
        });

        const range = await calendar.getEventsInRange(new Date('2026-05-01'), new Date('2026-06-01'));
        expect(range.map((occurrence) => occurrence.occurrenceDate)).toEqual([
            '2026-05-04',
            '2026-05-05',
            '2026-05-06',
        ]);
        expect(await calendar.getEventsByUid(SERIES)).toHaveLength(1);
    });
});
