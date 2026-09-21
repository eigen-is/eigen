import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { Calendar } from '../../lib/calendar/calendar';
import type { ReceiveInvitationPayload } from '../../lib/calendar/types';
import { parseIcs } from '../../lib/ical';
import { type ParsedEvent, utcStampString } from '../../lib/ical/ical-parse';
import { makeSyntheticUser } from '../../lib/user';
import { CALENDAR_TEST_ROOT, makeCalendar } from '../calendar-test-helpers';
import { vcal } from '../ics-test-helpers';

// RFC 5546 § 2.1.5 orders scheduling messages by SEQUENCE and then DTSTAMP, so a message that arrives out
// of order — a greylisted mail landing after the one that followed it, an unordered relay fan-out — never
// overwrites newer state, and a redelivery of one already applied changes nothing.

const ORG = 'organizer@external.com';
const UID = 'replay-guard@external.com';
const ORG_USER = `external_${ORG}`;
const GUEST = 'guest@test.local';

const request = (summary: string, sequence: number, dtstamp: string, extra: string[] = [], attendee = GUEST): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${UID}`,
        `SUMMARY:${summary}`,
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
        `SEQUENCE:${sequence}`,
        `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${attendee}`,
        `DTSTAMP:${dtstamp}`,
        ...extra,
        'END:VEVENT',
    ]);

// A sender that states no DTSTAMP: legal enough that parsers accept it, and nothing an ordering rule can
// compare — the stored copy always carries one, because the receiver's own write stamps it.
const stampless = (summary: string, sequence: number): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${UID}`,
        `SUMMARY:${summary}`,
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
        `SEQUENCE:${sequence}`,
        `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${GUEST}`,
        'END:VEVENT',
    ]);

// One occurrence of the series above, the shape Google and Outlook send for a "this event" edit.
const occurrence = (summary: string, sequence: number, dtstamp: string): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${UID}`,
        `SUMMARY:${summary}`,
        'RECURRENCE-ID:20260502T090000Z',
        'DTSTART:20260502T110000Z',
        'DTEND:20260502T120000Z',
        `SEQUENCE:${sequence}`,
        `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@test.local',
        `DTSTAMP:${dtstamp}`,
        'END:VEVENT',
    ]);

const parsedOf = (ics: string): ParsedEvent => parseIcs(ics).events[0];

async function seeded(): Promise<{ calendar: Calendar; calendarId: string }> {
    const harness = await makeCalendar();
    const calendar = harness.instance;
    const calendarId = (await calendar.getCalendars())[0].id;
    await calendar.receiveImipRequest(parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);
    return { calendar, calendarId };
}

const masterOf = async (calendar: Calendar): Promise<CalendarEvent> =>
    (await calendar.getEventsByUid(UID)).find((e) => !e.parentEventId)!;

const exceptionOf = async (calendar: Calendar): Promise<CalendarEvent | undefined> =>
    (await calendar.getEventsByUid(UID)).find((e) => e.parentEventId);

// The relay's own payload for the same series, so both transports are pinned by the same rule.
const relayPayload = (title: string, sequence: number, dtstamp: Date): ReceiveInvitationPayload => ({
    uid: UID,
    title,
    description: null,
    location: null,
    startTime: new Date('2026-05-01T09:00:00Z'),
    endTime: new Date('2026-05-01T10:00:00Z'),
    allDay: false,
    rrule: 'FREQ=DAILY;COUNT=5',
    timezone: null,
    status: 'confirmed',
    sequence,
    dtstamp,
    data: {
        organizer: { userId: 'organizer-home', email: ORG, name: 'Ext Org' },
        organizerEventId: 'organizer-event',
        attendees: [{ email: 'guest@test.local', status: 'pending', role: 'required' }],
    },
    createByUserId: 'organizer-home',
    organizerEventId: 'organizer-event',
    organizerUserId: 'organizer-home',
});

describe('inbound message ordering', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('iMIP: a REQUEST redelivered behind a newer one at the same SEQUENCE does not revert the title', async () => {
        const { calendar } = await seeded();

        await calendar.receiveImipRequest(parsedOf(request('Title B', 2, '20260401T120000Z')), ORG);
        expect((await masterOf(calendar)).title).toBe('Title B');

        // The greylisted copy of the first mail finally lands.
        await calendar.receiveImipRequest(parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    test('the relay applies the same rule to its unordered per-attendee fan-out', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveInvitation(relayPayload('Title A', 2, new Date('2026-04-01T10:00:00Z')));

        await calendar.receiveInvitationUpdate('organizer-event', 'organizer-home', {
            title: 'Title B',
            description: null,
            location: null,
            startTime: new Date('2026-05-01T09:00:00Z'),
            endTime: new Date('2026-05-01T10:00:00Z'),
            allDay: false,
            rrule: 'FREQ=DAILY;COUNT=5',
            timezone: null,
            status: 'confirmed',
            sequence: 2,
            dtstamp: new Date('2026-04-01T12:00:00Z'),
        });
        expect((await masterOf(calendar)).title).toBe('Title B');

        await calendar.receiveInvitationUpdate('organizer-event', 'organizer-home', {
            title: 'Title A',
            description: null,
            location: null,
            startTime: new Date('2026-05-01T09:00:00Z'),
            endTime: new Date('2026-05-01T10:00:00Z'),
            allDay: false,
            rrule: 'FREQ=DAILY;COUNT=5',
            timezone: null,
            status: 'confirmed',
            sequence: 2,
            dtstamp: new Date('2026-04-01T10:00:00Z'),
        });

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    test('a genuinely newer REQUEST at the same SEQUENCE still applies', async () => {
        const { calendar } = await seeded();

        await calendar.receiveImipRequest(parsedOf(request('Title B', 2, '20260401T120000Z')), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    test('an identical redelivery writes nothing', async () => {
        const { calendar, calendarId } = await seeded();
        const before = (await calendar.getCalendarById(calendarId))!.ctag;

        await calendar.receiveImipRequest(parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);

        expect((await calendar.getCalendarById(calendarId))!.ctag).toBe(before);
    });

    test('an occurrence REQUEST redelivered behind a newer one does not revert the occurrence', async () => {
        const { calendar } = await seeded();

        await calendar.receiveImipRequest(parsedOf(occurrence('Moved once', 2, '20260401T110000Z')), ORG);
        await calendar.receiveImipRequest(parsedOf(occurrence('Moved twice', 2, '20260401T120000Z')), ORG);
        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');

        await calendar.receiveImipRequest(parsedOf(occurrence('Moved once', 2, '20260401T110000Z')), ORG);

        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');
    });

    // Nothing orders two messages that state no stamp, so the later arrival is the later revision.
    test('a second REQUEST at one SEQUENCE with no DTSTAMP still applies', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;

        await calendar.receiveImipRequest(parsedOf(stampless('Title A', 2)), ORG);
        await calendar.receiveImipRequest(parsedOf(stampless('Title B', 2)), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    // An occurrence the attendee dropped keeps a stamp with the sequence a fresh exclusion carries and no
    // DTSTAMP at all, so the organizer's own message for it has nothing to lose an ordering to.
    test("an organizer's occurrence message reaches an occurrence the attendee removed locally", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        await calendar.receiveImipRequest(parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'declined',
            scope: 'this',
            recurrenceDate: '2026-05-02',
            remove: true,
        });
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');

        await calendar.receiveImipRequest(parsedOf(occurrence('Back on', 0, '20260401T120000Z')), ORG);

        expect((await exceptionOf(calendar))?.status).toBe('confirmed');
        expect((await exceptionOf(calendar))?.title).toBe('Back on');
    });

    // A buggy or compromised organizer client can stamp a message years ahead. Stored as it came, that
    // revision would outrank every genuine update that follows at the same SEQUENCE, forever.
    test('a REQUEST stamped far in the future never outranks the updates that follow it', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;

        await calendar.receiveImipRequest(parsedOf(request('Title 2099', 2, '20990101T000000Z')), ORG);
        expect((await masterOf(calendar)).title).toBe('Title 2099');

        const soon = utcStampString(new Date(Date.now() + 60_000));
        await calendar.receiveImipRequest(parsedOf(request('Title now', 2, soon)), ORG);

        expect((await masterOf(calendar)).title).toBe('Title now');
    });

    // The attendee's own copy mirrors the organizer's SEQUENCE, so a local edit of it — here, dropping one
    // occurrence — must leave that number alone; a bump would outrank every later message at the same one.
    test("an attendee removing one occurrence does not outrank the organizer's next update", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        const invite = (summary: string, dtstamp: string) => parsedOf(request(summary, 2, dtstamp, [], me.email));
        await calendar.receiveImipRequest(invite('Title A', '20260401T100000Z'), ORG);

        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'declined',
            scope: 'this',
            recurrenceDate: '2026-05-02',
            remove: true,
        });

        await calendar.receiveImipRequest(invite('Title B', '20260401T120000Z'), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');
    });

    test('a CANCEL redelivered behind the REQUEST that reinstated the occurrence does not re-cancel it', async () => {
        const { calendar } = await seeded();

        await calendar.cancelInvitationOccurrence(UID, ORG_USER, '2026-05-02', new Date('2026-05-02T09:00:00Z'), {
            sequence: 2,
            dtstamp: new Date('2026-04-01T11:00:00Z'),
        });
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');

        // The organizer put the occurrence back at the same SEQUENCE, with a later DTSTAMP.
        await calendar.receiveImipRequest(parsedOf(occurrence('Back on', 2, '20260401T120000Z')), ORG);
        expect((await exceptionOf(calendar))?.status).toBe('confirmed');

        await calendar.cancelInvitationOccurrence(UID, ORG_USER, '2026-05-02', new Date('2026-05-02T09:00:00Z'), {
            sequence: 2,
            dtstamp: new Date('2026-04-01T11:00:00Z'),
        });

        expect((await exceptionOf(calendar))?.status).toBe('confirmed');
    });
});
