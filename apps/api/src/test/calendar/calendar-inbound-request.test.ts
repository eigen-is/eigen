import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Calendar } from '../../lib/calendar/calendar';
import type { ReceiveInvitationPayload } from '../../lib/calendar/types';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { CALENDAR_TEST_ROOT, calendarsDirOf, makeCalendar } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

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
        const before = (await calendar.getRawEvents(id))[0];

        await calendar.receiveImipRequest(parsedOf(request()), ORG);

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
        // Stage 7's import writes this stamp; a planted file stands in for one, indexed by the reconcile.
        const planted = stored(null)
            .replace('DTSTAMP:20260101T000000Z', `X-EIGEN-IMPORTED-ORGANIZER:${ORG}\r\nDTSTAMP:20260101T000000Z`)
            .concat('\r\n');
        mkdirSync(join(calendarsDirOf(harness.dir), id), { recursive: true });
        writeFileSync(join(calendarsDirOf(harness.dir), id, 'imported.ics'), planted);

        const restarted = await harness.reopen();
        try {
            await restarted.instance.receiveImipRequest(parsedOf(request()), ORG);
            const rows = await restarted.instance.getEventsByUid(UID);
            expect(rows).toHaveLength(1);
            expect(rows[0].uri).toBe('imported.ics');
            expect(rows[0].data?.organizerEventId).toBe(UID);
        } finally {
            await restarted.close();
        }
    });

    test('a sender the stored event does not name is dropped', async () => {
        const { calendar, id } = await harnessWith(stored(ORG));

        await calendar.receiveImipRequest(parsedOf(request([], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizerEventId).toBeUndefined();
        expect(rows[0].title).toBe('Quarterly review (mine)');
        expect(await calendar.listResources(id)).toHaveLength(1);
    });

    test('a REQUEST for a UID linked to another organizer is dropped', async () => {
        const { calendar } = await harnessWith();
        await calendar.receiveImipRequest(parsedOf(request()), ORG);

        // A co-attendee re-sending the same series must not take the invitation over.
        await calendar.receiveImipRequest(parsedOf(request(['SEQUENCE:9'], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizer?.email).toBe(ORG);
        expect(rows[0].sequence).toBe(2);
    });

    test('a body whose ORGANIZER is not the sender never becomes an invitation', async () => {
        const { calendar, id } = await harnessWith();

        await calendar.receiveImipRequest(parsedOf(request([], ORG)), OTHER);

        expect(await calendar.getEventsByUid(UID)).toHaveLength(0);
        expect(await calendar.listResources(id)).toHaveLength(0);
    });

    test('a REQUEST the store refuses for its size is dropped, not half-written', async () => {
        const { calendar, id } = await harnessWith();
        const huge = 'x'.repeat(6_000_000);

        await calendar.receiveImipRequest(parsedOf(request([`DESCRIPTION:${huge}`])), ORG);

        expect(await calendar.getEventsByUid(UID)).toHaveLength(0);
        expect(await calendar.listResources(id)).toHaveLength(0);
    });

    test('two concurrent deliveries of one REQUEST leave one resource', async () => {
        const { calendar, id } = await harnessWith();
        const parsed = parsedOf(request());

        await Promise.all([calendar.receiveImipRequest(parsed, ORG), calendar.receiveImipRequest(parsed, ORG)]);

        expect(await calendar.listResources(id)).toHaveLength(1);
        expect(await calendar.getEventsByUid(UID)).toHaveLength(1);
    });
});

// The relay carries the same REQUEST from one Eigen Home to another, so it takes the same decision: the
// link it vouches for is the organizer's Home rather than an address, and nothing else differs.
describe('relayed invitation', () => {
    const ORG_HOME = 'organizer-home-id';
    const ORG_EVENT = 'organizer-event-id';

    const payload = (): ReceiveInvitationPayload => ({
        uid: UID,
        title: 'Quarterly review',
        description: null,
        location: null,
        startTime: new Date('2026-05-01T09:00:00Z'),
        endTime: new Date('2026-05-01T10:00:00Z'),
        allDay: false,
        rrule: null,
        timezone: null,
        status: 'confirmed',
        sequence: 2,
        dtstamp: new Date('2026-01-01T00:00:00Z'),
        data: {
            organizer: { userId: ORG_HOME, email: ORG, name: 'Ext Org' },
            organizerEventId: ORG_EVENT,
            attendees: [{ email: 'owner@test.local', status: 'pending', role: 'required' }],
        },
        createByUserId: ORG_HOME,
        organizerEventId: ORG_EVENT,
        organizerUserId: ORG_HOME,
    });

    test('a UID the Home holds in another calendar is never filed a second time', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const other = await calendar.createCalendar({ name: 'Work', color: '#aabbcc' });
        expect((await calendar.putResource(other.id, 'mine.ics', stored(null), NO_PRECONDITIONS)).ok).toBe(true);

        expect(await calendar.receiveInvitation(payload())).toBeNull();

        expect(await calendar.getEventsByUid(UID)).toHaveLength(1);
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

        const self = payload();
        const sent = await calendar.receiveInvitation({
            ...self,
            data: { ...self.data, organizer: { userId: harness.user.id, email: harness.user.email, name: 'Me' } },
            createByUserId: harness.user.id,
            organizerUserId: harness.user.id,
        });

        expect(sent).toBeNull();
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

        await calendar.receiveImipRequest(parsedOf(request()), ORG);

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
        const harness = await makeCalendar();
        const id = (await harness.instance.getCalendars())[0].id;
        const link = [`X-EIGEN-ORGANIZER-EVENT:${UID}`, `X-EIGEN-ORGANIZER-USER:external_${ORG}`];
        const planted = `${vcal(
            [
                'BEGIN:VEVENT',
                `UID:${UID}`,
                'SUMMARY:Moved occurrence',
                'RECURRENCE-ID:20260502T090000Z',
                'DTSTART:20260502T110000Z',
                'DTEND:20260502T120000Z',
                'SEQUENCE:2',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                ...link,
                'X-EIGEN-EVENT-ID:11111111-1111-4111-8111-111111111111',
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
                'SEQUENCE:2',
                `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                ...link,
                'X-EIGEN-EVENT-ID:22222222-2222-4222-8222-222222222222',
                'DTSTAMP:20260101T000000Z',
                'END:VEVENT',
            ],
        )}\r\n`;
        mkdirSync(join(calendarsDirOf(harness.dir), id), { recursive: true });
        writeFileSync(join(calendarsDirOf(harness.dir), id, 'linked.ics'), planted);

        const restarted = await harness.reopen();
        try {
            const series = request(['RRULE:FREQ=DAILY;COUNT=5'])
                .replace('SEQUENCE:2', 'SEQUENCE:3')
                .replace('SUMMARY:Quarterly review', 'SUMMARY:Renamed series');
            await restarted.instance.receiveImipRequest(parsedOf(series), ORG);

            const rows = await restarted.instance.getEventsByUid(UID);
            expect(rows.find((r) => !r.parentEventId)?.title).toBe('Renamed series');
            expect(rows.find((r) => r.parentEventId)?.title).toBe('Moved occurrence');
        } finally {
            await restarted.close();
        }
    });

    test('the organizer an event in another calendar names adopts it in place', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const other = await calendar.createCalendar({ name: 'Work', color: '#aabbcc' });
        expect((await calendar.putResource(other.id, 'mine.ics', stored(ORG), NO_PRECONDITIONS)).ok).toBe(true);

        await calendar.receiveInvitation(payload());

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].calendarId).toBe(other.id);
        expect(rows[0].data?.organizerEventId).toBe(ORG_EVENT);
        expect(rows[0].data?.organizer?.userId).toBe(ORG_HOME);
    });
});
