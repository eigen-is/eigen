import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { Attendee } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import type { Calendar } from '../../lib/calendar/calendar';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { icalTimeToInstant, parseResource, propTzid } from '../../lib/ical/ical-parse';
import { makeSyntheticUser } from '../../lib/user';
import {
    CALENDAR_TEST_ROOT,
    makeCalendar,
    receiveMailed,
    resourceTextOf,
    storedEvents,
} from '../calendar-test-helpers';
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

    // An override the copy lacked is built from the row before the claim, and still has to carry the link.
    test('an adoption links the occurrences it adds', async () => {
        const weekly = ['RRULE:FREQ=WEEKLY;COUNT=4'];
        const { calendar } = await harnessWith(stored(ORG).replace('DTSTAMP', `${weekly[0]}\r\nDTSTAMP`));
        const moved = [
            'BEGIN:VEVENT',
            `UID:${UID}`,
            'SUMMARY:Quarterly review moved',
            'RECURRENCE-ID:20260508T090000Z',
            'DTSTART:20260508T110000Z',
            'DTEND:20260508T120000Z',
            'SEQUENCE:2',
            `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@test.local',
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ];

        await calendar.receiveRequest(
            parseIcs(request(weekly).replace('END:VCALENDAR', `${moved.join('\r\n')}\r\nEND:VCALENDAR`)).events,
            {
                organizerEmail: ORG,
                organizerEventId: UID,
                organizerUserId: `external_${ORG}`,
                createByUserId: `external_${ORG}`,
            },
        );

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.data?.organizerEventId).toBe(UID);
            expect(row.data?.organizer?.userId).toBe(`external_${ORG}`);
        }
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
        recurrenceId: null,
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
            recurrenceId: null,
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

    // The file names one occurrence twice: the later of two equal revisions stands, and the copy keeps it live.
    test('an occurrence the message cancels and then restates stays a live override', async () => {
        const { harness, calendar, id } = await harnessWith();
        const [master, moved] = seriesRequest(harness.user.email, 1);
        await calendar.receiveRequest([master, moved], LINK);
        const update = { ...moved, sequence: 1, title: 'Standup kept' };

        await calendar.receiveRequest([{ ...master, sequence: 1 }, { ...update, status: 'cancelled' }, update], LINK);

        const rows = storedEvents(calendar, id);
        expect(rows).toHaveLength(2);
        expect(findOrFail(rows, (e) => !!e.parentEventId)).toMatchObject({
            title: 'Standup kept',
            status: 'confirmed',
        });
    });

    // A STATUS:CANCELLED on the copy's own VEVENT is the organizer's word, not the guest's decline.
    test("a series the organizer cancels and restores at one SEQUENCE keeps the guest's answer", async () => {
        const { harness, calendar } = await harnessWith();
        const [master] = seriesRequest(harness.user.email, 0);
        await calendar.receiveRequest([master], LINK);
        const [copy] = await calendar.getEventsByUid(master.uid);
        await calendar.receiveAttendeeStatus(copy.id, harness.user.email, 'accepted');

        await calendar.receiveRequest([{ ...master, status: 'cancelled' }], LINK);
        await calendar.receiveRequest([master], LINK);

        const [restored] = await calendar.getEventsByUid(master.uid);
        expect(restored.status).toBe('confirmed');
        expect(restored.data?.attendees?.[0]).toMatchObject({ email: harness.user.email, status: 'accepted' });
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
    const link = {
        organizerEmail: ORG,
        organizerEventId: SERIES,
        organizerUserId: `external_${ORG}`,
        createByUserId: `external_${ORG}`,
    };
    const series = (guest: string, title: string, rrule = 'FREQ=DAILY;COUNT=10', start = '20260504'): ParsedEvent[] =>
        parseIcs(
            vcal([
                'BEGIN:VEVENT',
                `UID:${SERIES}`,
                `SUMMARY:${title}`,
                `RRULE:${rrule}`,
                `DTSTART:${start}T090000Z`,
                `DTEND:${start}T093000Z`,
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

    // The guest holds the series from 4 May and cuts it from 7 May on.
    async function cutCopy(rrule?: string) {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveRequest(series(harness.user.email, 'Standup', rrule), link);
        const master = findOrFail(await calendar.getEventsByUid(SERIES), (e) => !e.parentEventId);
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        await calendar.rsvp(master.id, me, {
            status: 'declined',
            scope: 'this-and-following',
            recurrenceDate: '2026-05-07',
            remove: true,
        });
        return { harness, calendar };
    }

    const storedRule = async (calendar: Calendar): Promise<string | null> =>
        findOrFail(await calendar.getEventsByUid(SERIES), (e) => !e.parentEventId).rrule;

    test('keeps no moved or cancelled occurrence past the cut', async () => {
        const { harness, calendar } = await cutCopy();

        const range = await calendar.getEventsInRange(new Date('2026-05-01'), new Date('2026-06-01'));
        expect(range.map((occurrence) => occurrence.occurrenceDate)).toEqual([
            '2026-05-04',
            '2026-05-05',
            '2026-05-06',
        ]);
        expect(await calendar.getEventsByUid(SERIES)).toHaveLength(1);

        await calendar.receiveRequest(series(harness.user.email, 'Standup renamed'), link);

        const after = await calendar.getEventsByUid(SERIES);
        expect(after.map((event) => event.title)).toEqual(['Standup renamed']);
    });

    test('keeps the cut through an update that ends later', async () => {
        const { harness, calendar } = await cutCopy();

        await calendar.receiveRequest(series(harness.user.email, 'Standup', 'FREQ=DAILY;UNTIL=20260520T235959Z'), link);

        expect(await storedRule(calendar)).toBe('FREQ=DAILY;UNTIL=20260506T235959Z');
    });

    test("takes an organizer's end before the cut as it is", async () => {
        const { harness, calendar } = await cutCopy();

        await calendar.receiveRequest(series(harness.user.email, 'Standup', 'FREQ=DAILY;UNTIL=20260505T090000Z'), link);

        expect(await storedRule(calendar)).toBe('FREQ=DAILY;UNTIL=20260505T090000Z');
    });

    test('keeps the cut, fast, through a rule that never fires from 1900', async () => {
        const { harness, calendar } = await cutCopy();
        const never = series(harness.user.email, 'Standup', 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', '19000102');
        const startedAt = performance.now();

        await calendar.receiveRequest(never, link);

        expect(performance.now() - startedAt).toBeLessThan(1000);
        const { calendarId } = findOrFail(await calendar.getEventsByUid(SERIES), (e) => !e.parentEventId);
        const resource = findOrFail(await calendar.listResources(calendarId), (r) => r.uid === SERIES);
        const text = await resourceTextOf(calendar, calendarId, resource.uri);
        expect(text).toContain('RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;UNTIL=20260506T235959Z');
    });

    test("keeps the cut its own client puts back, whatever cut the client's bytes state", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const id = (await calendar.getCalendars())[0].id;
        // The guest's own client filed the invitation, so the copy names the organizer but holds no link.
        const [mine] = series(harness.user.email, 'Standup');
        const body = vcal([
            'BEGIN:VEVENT',
            `UID:${SERIES}`,
            'SUMMARY:Standup',
            'RRULE:FREQ=DAILY;COUNT=10',
            'DTSTART:20260504T090000Z',
            'DTEND:20260504T093000Z',
            `ORGANIZER:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${harness.user.email}`,
            'DTSTAMP:20260101T000000Z',
            'END:VEVENT',
        ]);
        expect((await calendar.putResource(id, 'mine.ics', body, NO_PRECONDITIONS)).ok).toBe(true);
        const [held] = await calendar.getEventsByUid(SERIES);
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        await calendar.rsvp(held.id, me, {
            status: 'declined',
            scope: 'this-and-following',
            recurrenceDate: '2026-05-07',
            remove: true,
        });

        const cut = await resourceTextOf(calendar, id, 'mine.ics');
        const forged = cut.replace('X-EIGEN-GUEST-CUT:2026-05-07', 'X-EIGEN-GUEST-CUT:2026-05-20');
        expect(forged).not.toBe(cut);
        expect((await calendar.putResource(id, 'mine.ics', forged, NO_PRECONDITIONS)).ok).toBe(true);
        await calendar.receiveRequest([{ ...mine, rrule: 'FREQ=DAILY;UNTIL=20260520T235959Z', sequence: 1 }], link);

        expect(await storedRule(calendar)).toBe('FREQ=DAILY;UNTIL=20260506T235959Z');
    });

    test("an organizer's longer series reaches a guest who never cut it", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveRequest(series(harness.user.email, 'Standup', 'FREQ=DAILY;UNTIL=20260510T235959Z'), link);

        await calendar.receiveRequest(series(harness.user.email, 'Standup', 'FREQ=DAILY;UNTIL=20261231T235959Z'), link);

        expect(await storedRule(calendar)).toBe('FREQ=DAILY;UNTIL=20261231T235959Z');
    });
});

// A RECURRENCE-ID names an instant (RFC 5545), and its occurrence is the one the series' wall clock shows at it.
describe('a lone occurrence named in another zone', () => {
    const SERIES = 'date-line@external.com';
    const link = {
        organizerEmail: ORG,
        organizerEventId: SERIES,
        organizerUserId: `external_${ORG}`,
        createByUserId: `external_${ORG}`,
    };
    const vevent = (guest: string, lines: string[]): string[] => [
        'BEGIN:VEVENT',
        `UID:${SERIES}`,
        `ORGANIZER:mailto:${ORG}`,
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
        'DTSTAMP:20260101T000000Z',
        ...lines,
        'END:VEVENT',
    ];

    test('replaces the occurrence the series has at that instant', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const guest = harness.user.email;
        const daily = [
            'SUMMARY:Auckland standup',
            'RRULE:FREQ=DAILY;COUNT=10',
            'DTSTART;TZID=Pacific/Auckland:20260504T090000',
            'DTEND;TZID=Pacific/Auckland:20260504T093000',
        ];
        await calendar.receiveRequest(parseIcs(vcal(vevent(guest, daily))).events, link);

        // 17:00 on 5 May in New York is 09:00 on 6 May in Auckland.
        const lone = [
            'SUMMARY:Renamed in New York',
            'RECURRENCE-ID;TZID=America/New_York:20260505T170000',
            'DTSTART;TZID=America/New_York:20260505T170000',
            'DTEND;TZID=America/New_York:20260505T173000',
            'SEQUENCE:1',
        ];
        await calendar.receiveRequest(parseIcs(vcal(vevent(guest, lone))).events, link);

        const override = findOrFail(await calendar.getEventsByUid(SERIES), (e) => !!e.parentEventId);
        expect(override.recurrenceDate).toBe('2026-05-06');
        const resource = findOrFail(await calendar.listResources(override.calendarId), (r) => r.uid === SERIES);
        const text = await resourceTextOf(calendar, override.calendarId, resource.uri);
        expect(text).toContain('RECURRENCE-ID;TZID=Pacific/Auckland:20260506T090000\r\n');
        const range = await calendar.getEventsInRange(new Date('2026-05-01'), new Date('2026-06-01'));
        expect(range).toHaveLength(10);
    });
});

// A copy of single dates holds no master, so the zone its RECURRENCE-ID is written in is the only series zone it knows.
describe('a copy of one date named in another zone than its start', () => {
    const DATE = 'one-date-two-zones@external.com';
    const occurrence = (guest: string, lines: string[]): ParsedEvent[] =>
        parseIcs(
            vcal([
                'BEGIN:VEVENT',
                `UID:${DATE}`,
                'RECURRENCE-ID;TZID=Europe/Amsterdam:20260510T003000',
                `ORGANIZER:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
                ...lines,
                'END:VEVENT',
            ]),
        ).events;
    const link = {
        organizerEmail: ORG,
        organizerEventId: DATE,
        organizerUserId: `external_${ORG}`,
        createByUserId: `external_${ORG}`,
    };

    async function stored(calendar: Calendar) {
        const events = await calendar.getEventsByUid(DATE);
        const { calendarId } = events[0];
        const resource = findOrFail(await calendar.listResources(calendarId), (r) => r.uid === DATE);
        return { events, text: await resourceTextOf(calendar, calendarId, resource.uri) };
    }

    test('keeps its RECURRENCE-ID and its date through an update', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const guest = harness.user.email;
        const inNewYork = (title: string, sequence: number) => [
            `SUMMARY:${title}`,
            'DTSTART;TZID=America/New_York:20260509T183000',
            'DTEND;TZID=America/New_York:20260509T193000',
            `SEQUENCE:${sequence}`,
            `DTSTAMP:2026010${sequence + 1}T000000Z`,
        ];
        await calendar.receiveRequest(occurrence(guest, inNewYork('Late call', 0)), link);
        await calendar.receiveRequest(occurrence(guest, inNewYork('Late call renamed', 1)), link);

        const { events, text } = await stored(calendar);
        expect(events.map((e) => [e.title, e.recurrenceDate])).toEqual([['Late call renamed', '2026-05-10']]);
        expect(text).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260510T003000\r\n');
    });

    test('made all day, still names the timed occurrence', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const allDay = [
            'SUMMARY:Day off',
            'DTSTART;VALUE=DATE:20260510',
            'DTEND;VALUE=DATE:20260511',
            'DTSTAMP:20260101T000000Z',
        ];
        await calendar.receiveRequest(occurrence(harness.user.email, allDay), link);

        const { events, text } = await stored(calendar);
        expect(events.map((e) => e.recurrenceDate)).toEqual(['2026-05-10']);
        expect(text).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260510T003000\r\n');
    });
});

// A guest's copy names a new occurrence by the series the same message states, never by the one it held before.
describe('a series moved in the same message as a new occurrence', () => {
    const SERIES = 'moved-with-override@external.com';
    const link = {
        organizerEmail: ORG,
        organizerEventId: SERIES,
        organizerUserId: `external_${ORG}`,
        createByUserId: `external_${ORG}`,
    };
    const master = (guest: string, hour: string, sequence: number): string[] => [
        'BEGIN:VEVENT',
        `UID:${SERIES}`,
        'SUMMARY:Weekly',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        `DTSTART;TZID=Europe/Amsterdam:20260504T${hour}0000`,
        `DTEND;TZID=Europe/Amsterdam:20260504T${hour}3000`,
        `SEQUENCE:${sequence}`,
        `ORGANIZER:mailto:${ORG}`,
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
        `DTSTAMP:2026010${sequence + 1}T000000Z`,
        'END:VEVENT',
    ];

    test("names the override's RECURRENCE-ID at the series' new time", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const guest = harness.user.email;
        await calendar.receiveRequest(parseIcs(vcal(master(guest, '09', 0))).events, link);

        const override = [
            'BEGIN:VEVENT',
            `UID:${SERIES}`,
            'SUMMARY:Weekly, longer',
            'RECURRENCE-ID;TZID=Europe/Amsterdam:20260511T100000',
            'DTSTART;TZID=Europe/Amsterdam:20260511T100000',
            'DTEND;TZID=Europe/Amsterdam:20260511T120000',
            'SEQUENCE:1',
            `ORGANIZER:mailto:${ORG}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
            'DTSTAMP:20260102T000000Z',
            'END:VEVENT',
        ];
        await calendar.receiveRequest(parseIcs(vcal(master(guest, '10', 1), override)).events, link);

        const { calendarId } = findOrFail(await calendar.getEventsByUid(SERIES), (e) => !e.parentEventId);
        const resource = findOrFail(await calendar.listResources(calendarId), (r) => r.uid === SERIES);
        const text = await resourceTextOf(calendar, calendarId, resource.uri);
        expect(text).toContain('RECURRENCE-ID;TZID=Europe/Amsterdam:20260511T100000\r\n');
    });
});

// Google and Outlook match a reply to their occurrence by the instant its RECURRENCE-ID names, which a copy of one
// date can only take from the organizer's own line: it holds no series to compute that instant from.
describe('a copy of one moved date', () => {
    const DATE = 'one-moved-date@external.com';
    const ORIGINAL = new Date('2028-03-13T08:00:00Z');
    const moved = (guest: string): ParsedEvent =>
        parsedOf(
            vcal([
                'BEGIN:VEVENT',
                `UID:${DATE}`,
                'SUMMARY:Moved standup',
                'RECURRENCE-ID;TZID=Europe/Amsterdam:20280313T090000',
                'DTSTART;TZID=Europe/Amsterdam:20280313T110000',
                'DTEND;TZID=Europe/Amsterdam:20280313T120000',
                `ORGANIZER:mailto:${ORG}`,
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`,
                'DTSTAMP:20280101T000000Z',
                'END:VEVENT',
            ]),
        );
    const recurrenceInstant = (ics: string): Date | null => {
        const prop = parseResource(ics).getFirstSubcomponent('vevent')?.getFirstProperty('recurrence-id');
        const value = prop?.getFirstValue();
        return value instanceof ICAL.Time ? icalTimeToInstant(value, propTzid(prop), null) : null;
    };

    async function filed() {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await receiveMailed(calendar, moved(harness.user.email), ORG);
        const [copy] = await calendar.getEventsByUid(DATE);
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        const mailer = await import('../../lib/mailer/mailer');
        const sent = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        sent.mockClear();
        const reply = () => findOrFail(sent.mock.calls, ([mail]) => mail.icalEvent?.method === 'REPLY')[0];
        return { calendar, copy, me, sent, reply };
    }

    test("keeps the organizer's RECURRENCE-ID, and an answer names it", async () => {
        const { calendar, copy, me, sent, reply } = await filed();
        try {
            const resource = findOrFail(await calendar.listResources(copy.calendarId), (r) => r.uid === DATE);
            expect(recurrenceInstant(await resourceTextOf(calendar, copy.calendarId, resource.uri))).toEqual(ORIGINAL);

            await calendar.rsvp(copy.id, me, { status: 'accepted' });
            expect(recurrenceInstant(reply().icalEvent?.content ?? '')).toEqual(ORIGINAL);
        } finally {
            sent.mockRestore();
        }
    });

    test("a delete declines the organizer's occurrence", async () => {
        const { calendar, copy, me, sent, reply } = await filed();
        try {
            await calendar.deleteEvent(copy.calendarId, copy.id, me);
            expect(reply().icalEvent?.content).toContain('PARTSTAT=DECLINED');
            expect(recurrenceInstant(reply().icalEvent?.content ?? '')).toEqual(ORIGINAL);
        } finally {
            sent.mockRestore();
        }
    });
});
