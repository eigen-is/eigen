import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { Calendar } from '../../lib/calendar/calendar';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { utcStampString } from '../../lib/ical/ical-parse';
import { makeSyntheticUser } from '../../lib/user';
import { CALENDAR_TEST_ROOT, makeCalendar, receiveMailed } from '../calendar-test-helpers';
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
    await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);
    return { calendar, calendarId };
}

const masterOf = async (calendar: Calendar): Promise<CalendarEvent> =>
    (await calendar.getEventsByUid(UID)).find((e) => !e.parentEventId)!;

const exceptionOf = async (calendar: Calendar): Promise<CalendarEvent | undefined> =>
    (await calendar.getEventsByUid(UID)).find((e) => e.parentEventId);

// The relay's own message for the same series, so both transports are pinned by the same rule.
const RELAY_LINK = {
    organizerEmail: ORG,
    organizerEventId: 'organizer-event',
    organizerUserId: 'organizer-home',
    createByUserId: 'organizer-home',
};
const relayed = (title: string, sequence: number, dtstamp: string): ParsedEvent => ({
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
    dtstamp: new Date(dtstamp),
    recurrenceDate: null,
    recurrenceId: null,
    data: {
        organizer: { userId: 'organizer-home', email: ORG, name: 'Ext Org' },
        attendees: [{ email: GUEST, status: 'pending', role: 'required' }],
    },
});
const relay = (calendar: Calendar, ...requested: ParsedEvent[]) => calendar.receiveRequest(requested, RELAY_LINK);

describe('inbound message ordering', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('iMIP: a REQUEST redelivered behind a newer one at the same SEQUENCE does not revert the title', async () => {
        const { calendar } = await seeded();

        await receiveMailed(calendar, parsedOf(request('Title B', 2, '20260401T120000Z')), ORG);
        expect((await masterOf(calendar)).title).toBe('Title B');

        // The greylisted copy of the first mail finally lands.
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    test('the relay applies the same rule to its unordered per-attendee fan-out', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await relay(calendar, relayed('Title A', 2, '2026-04-01T10:00:00Z'));

        await relay(calendar, relayed('Title B', 2, '2026-04-01T12:00:00Z'));
        expect((await masterOf(calendar)).title).toBe('Title B');

        await relay(calendar, relayed('Title A', 2, '2026-04-01T10:00:00Z'));

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    // The relay's occurrence messages are ordered per occurrence, against the exception's own revision.
    test('a relayed occurrence edit redelivered behind a newer one does not revert the occurrence', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await relay(calendar, relayed('Title A', 2, '2026-04-01T10:00:00Z'));

        const occurrenceEdit = (title: string, dtstamp: string): ParsedEvent => ({
            ...relayed(title, 2, dtstamp),
            recurrenceDate: '2026-05-02',
            rrule: null,
            startTime: new Date('2026-05-02T11:00:00Z'),
            endTime: new Date('2026-05-02T12:00:00Z'),
        });

        await relay(calendar, occurrenceEdit('Moved once', '2026-04-01T11:00:00Z'));
        await relay(calendar, occurrenceEdit('Moved twice', '2026-04-01T12:00:00Z'));
        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');

        await relay(calendar, occurrenceEdit('Moved once', '2026-04-01T11:00:00Z'));

        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');
        // The series itself never took the occurrence's title.
        expect((await masterOf(calendar)).title).toBe('Title A');
    });

    test('a genuinely newer REQUEST at the same SEQUENCE still applies', async () => {
        const { calendar } = await seeded();

        await receiveMailed(calendar, parsedOf(request('Title B', 2, '20260401T120000Z')), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    test('a newer REQUEST at the same SEQUENCE that only drops the location reaches the guest', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', ['LOCATION:Room 9'])), ORG);
        expect((await masterOf(calendar)).location).toBe('Room 9');

        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T120000Z')), ORG);

        expect((await masterOf(calendar)).location).toBeNull();
    });

    test('the relay applies a cleared description at the same SEQUENCE', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await relay(calendar, { ...relayed('Title A', 2, '2026-04-01T10:00:00Z'), description: 'Agenda' });
        expect((await masterOf(calendar)).description).toBe('Agenda');

        await relay(calendar, relayed('Title A', 2, '2026-04-01T12:00:00Z'));

        expect((await masterOf(calendar)).description).toBeNull();
    });

    test('an identical redelivery writes nothing', async () => {
        const { calendar, calendarId } = await seeded();
        const before = (await calendar.getCalendarById(calendarId))!.ctag;

        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z')), ORG);

        expect((await calendar.getCalendarById(calendarId))!.ctag).toBe(before);
    });

    test('a series REQUEST with a moved and a cancelled occurrence, delivered twice, writes nothing the second time', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;
        const series = parseIcs(
            vcal(
                [
                    'BEGIN:VEVENT',
                    `UID:${UID}`,
                    'SUMMARY:Title A',
                    'DTSTART:20260501T090000Z',
                    'DTEND:20260501T100000Z',
                    'RRULE:FREQ=DAILY;COUNT=5',
                    'EXDATE:20260503T090000Z',
                    'SEQUENCE:2',
                    `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${GUEST}`,
                    'DTSTAMP:20260401T100000Z',
                    'END:VEVENT',
                ],
                [
                    'BEGIN:VEVENT',
                    `UID:${UID}`,
                    'SUMMARY:Moved once',
                    'RECURRENCE-ID:20260502T090000Z',
                    'DTSTART:20260502T110000Z',
                    'DTEND:20260502T120000Z',
                    'SEQUENCE:2',
                    `ORGANIZER;CN=Ext Org:mailto:${ORG}`,
                    `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${GUEST}`,
                    'DTSTAMP:20260401T100000Z',
                    'END:VEVENT',
                ],
            ),
        ).events;
        const deliver = async () => {
            for (const parsed of series) await receiveMailed(calendar, parsed, ORG);
        };
        await deliver();
        expect((await calendar.getEventsByUid(UID)).map((e) => e.status)).toEqual([
            'confirmed',
            'cancelled',
            'confirmed',
        ]);
        const ctag = (await calendar.getCalendarById(calendarId))?.ctag;
        const broadcasts = harness.broadcasts.length;

        await deliver();

        expect((await calendar.getCalendarById(calendarId))?.ctag).toBe(ctag);
        expect(harness.broadcasts.length).toBe(broadcasts);
    });

    test('an occurrence REQUEST redelivered behind a newer one does not revert the occurrence', async () => {
        const { calendar } = await seeded();

        await receiveMailed(calendar, parsedOf(occurrence('Moved once', 2, '20260401T110000Z')), ORG);
        await receiveMailed(calendar, parsedOf(occurrence('Moved twice', 2, '20260401T120000Z')), ORG);
        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');

        await receiveMailed(calendar, parsedOf(occurrence('Moved once', 2, '20260401T110000Z')), ORG);

        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');
    });

    // Nothing orders two messages that state no stamp, so the later arrival is the later revision.
    test('a second REQUEST at one SEQUENCE with no DTSTAMP still applies', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;

        await receiveMailed(calendar, parsedOf(stampless('Title A', 2)), ORG);
        await receiveMailed(calendar, parsedOf(stampless('Title B', 2)), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
    });

    // An occurrence the attendee dropped keeps a stamp with the sequence a fresh exclusion carries and no
    // DTSTAMP at all, so the organizer's own message for it has nothing to lose an ordering to.
    test("an organizer's occurrence message reaches an occurrence the attendee removed locally", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'declined',
            scope: 'this',
            recurrenceDate: '2026-05-02',
            remove: true,
        });
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');

        await receiveMailed(calendar, parsedOf(occurrence('Back on', 0, '20260401T120000Z')), ORG);

        expect((await exceptionOf(calendar))?.status).toBe('confirmed');
        expect((await exceptionOf(calendar))?.title).toBe('Back on');
    });

    // A buggy or compromised organizer client can stamp a message years ahead. Stored as it came, that
    // revision would outrank every genuine update that follows at the same SEQUENCE, forever.
    test('a REQUEST stamped far in the future never outranks the updates that follow it', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;

        await receiveMailed(calendar, parsedOf(request('Title 2099', 2, '20990101T000000Z')), ORG);
        expect((await masterOf(calendar)).title).toBe('Title 2099');

        const soon = utcStampString(new Date(Date.now() + 60_000));
        await receiveMailed(calendar, parsedOf(request('Title now', 2, soon)), ORG);

        expect((await masterOf(calendar)).title).toBe('Title now');
    });

    // The attendee's own copy mirrors the organizer's SEQUENCE, so a local edit of it — here, dropping one
    // occurrence — must leave that number alone; a bump would outrank every later message at the same one.
    test("an attendee removing one occurrence does not outrank the organizer's next update", async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        const invite = (summary: string, dtstamp: string) => parsedOf(request(summary, 2, dtstamp, [], me.email));
        await receiveMailed(calendar, invite('Title A', '20260401T100000Z'), ORG);

        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'declined',
            scope: 'this',
            recurrenceDate: '2026-05-02',
            remove: true,
        });

        await receiveMailed(calendar, invite('Title B', '20260401T120000Z'), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');
    });

    // A cancelled occurrence keeps its revision beside its EXDATE, in the stored bytes, so a rewrite of the
    // resource for an unrelated reason leaves nothing for an older message to slip through.
    test('a REQUEST redelivered behind the CANCEL that dropped the occurrence survives a rewrite', async () => {
        const { calendar } = await seeded();

        await receiveMailed(calendar, parsedOf(occurrence('Moved once', 2, '20260401T100000Z')), ORG);
        await calendar.cancelInvitationOccurrence(UID, ORG_USER, {
            recurrenceDate: '2026-05-02',
            recurrenceId: { instant: new Date('2026-05-02T09:00:00Z'), timezone: null },
            sequence: 2,
            dtstamp: new Date('2026-04-01T11:00:00Z'),
        });
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');

        // An unrelated series update rewrites the resource, and with it every row it projects.
        await receiveMailed(calendar, parsedOf(request('Title B', 2, '20260401T130000Z')), ORG);

        await receiveMailed(calendar, parsedOf(occurrence('Moved once', 2, '20260401T100000Z')), ORG);

        expect((await exceptionOf(calendar))?.status).toBe('cancelled');
    });

    test('a CANCEL redelivered behind the REQUEST that reinstated the occurrence does not re-cancel it', async () => {
        const { calendar } = await seeded();

        await calendar.cancelInvitationOccurrence(UID, ORG_USER, {
            recurrenceDate: '2026-05-02',
            recurrenceId: { instant: new Date('2026-05-02T09:00:00Z'), timezone: null },
            sequence: 2,
            dtstamp: new Date('2026-04-01T11:00:00Z'),
        });
        expect((await exceptionOf(calendar))?.status).toBe('cancelled');

        // The organizer put the occurrence back at the same SEQUENCE, with a later DTSTAMP.
        await receiveMailed(calendar, parsedOf(occurrence('Back on', 2, '20260401T120000Z')), ORG);
        expect((await exceptionOf(calendar))?.status).toBe('confirmed');

        await calendar.cancelInvitationOccurrence(UID, ORG_USER, {
            recurrenceDate: '2026-05-02',
            recurrenceId: { instant: new Date('2026-05-02T09:00:00Z'), timezone: null },
            sequence: 2,
            dtstamp: new Date('2026-04-01T11:00:00Z'),
        });

        expect((await exceptionOf(calendar))?.status).toBe('confirmed');
    });
});

// An organizer's list often still says NEEDS-ACTION for a guest whose reply it hasn't read. Only a rescheduling,
// which raises the SEQUENCE, asks the guest to answer again.
describe("the guest's own answer", () => {
    const answered = async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const me = makeSyntheticUser(harness.user.id, harness.user.name, harness.user.email);
        const mine = (event: CalendarEvent | undefined) =>
            event?.data?.attendees?.find((a) => a.email === me.email)?.status;
        return { calendar, me, mine };
    };

    test('stays through an update at the same SEQUENCE and resets at a higher one', async () => {
        const { calendar, me, mine } = await answered();
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, { status: 'accepted' });

        await receiveMailed(calendar, parsedOf(request('Title B', 2, '20260401T120000Z', [], me.email)), ORG);

        expect((await masterOf(calendar)).title).toBe('Title B');
        expect(mine(await masterOf(calendar))).toBe('accepted');

        await receiveMailed(calendar, parsedOf(request('Title C', 3, '20260401T130000Z', [], me.email)), ORG);

        expect(mine(await masterOf(calendar))).toBe('pending');
    });

    // A copy without a rule has one occurrence, so an answer for "this one" is an answer for all of it.
    test('to one date of a copy without a rule answers for the copy', async () => {
        const { calendar, me, mine } = await answered();
        const single = request('Single', 2, '20260401T100000Z', [], me.email).replace(
            'RRULE:FREQ=DAILY;COUNT=5\r\n',
            '',
        );
        // One occurrence of a series this Home doesn't hold files as a copy of its own, with no rule either.
        const lone = occurrence('Lone', 2, '20260401T100000Z')
            .replace(`UID:${UID}`, 'UID:lone@external.com')
            .replace(`mailto:${GUEST}`, `mailto:${me.email}`);
        await receiveMailed(calendar, parsedOf(single), ORG);
        await receiveMailed(calendar, parsedOf(lone), ORG);
        const [copy] = await calendar.getEventsByUid('lone@external.com');

        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'accepted',
            scope: 'this',
            recurrenceDate: '2026-05-01',
        });
        await calendar.rsvp(copy.id, me, {
            status: 'declined',
            scope: 'this',
            recurrenceDate: '2026-05-02',
            remove: true,
        });

        expect(mine(await masterOf(calendar))).toBe('accepted');
        expect(await calendar.getEventsByUid('lone@external.com')).toEqual([]);
    });

    test('stays on one occurrence through an update to it at the same SEQUENCE', async () => {
        const { calendar, me, mine } = await answered();
        const moved = (summary: string, sequence: number, dtstamp: string) =>
            parsedOf(occurrence(summary, sequence, dtstamp).replace(`mailto:${GUEST}`, `mailto:${me.email}`));
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await receiveMailed(calendar, moved('Moved once', 2, '20260401T110000Z'), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, {
            status: 'accepted',
            scope: 'this',
            recurrenceDate: '2026-05-02',
        });

        await receiveMailed(calendar, moved('Moved twice', 2, '20260401T120000Z'), ORG);

        expect((await exceptionOf(calendar))?.title).toBe('Moved twice');
        expect(mine(await exceptionOf(calendar))).toBe('accepted');

        await receiveMailed(calendar, moved('Moved again', 3, '20260401T130000Z'), ORG);

        expect(mine(await exceptionOf(calendar))).toBe('pending');
    });

    test('is never set to another answer by the organizer, even at a higher SEQUENCE', async () => {
        const { calendar, me, mine } = await answered();
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, { status: 'accepted' });

        for (const [partstat, sequence] of [
            ['DECLINED', 3],
            ['TENTATIVE', 4],
        ] as const) {
            const update = request('Rescheduled', sequence, '20260401T130000Z', [], me.email);
            await receiveMailed(
                calendar,
                parsedOf(update.replace('PARTSTAT=NEEDS-ACTION', `PARTSTAT=${partstat}`)),
                ORG,
            );
            expect(mine(await masterOf(calendar))).toBe('accepted');
        }
    });

    // The organizer records a cut as a decline of the whole series, and a date it moves before the cut carries that.
    test("reaches a date the organizer moves after the guest's cut", async () => {
        const { calendar, me, mine } = await answered();
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        const master = await masterOf(calendar);
        await calendar.rsvp(master.id, me, { status: 'accepted' });
        await calendar.rsvp(master.id, me, {
            status: 'declined',
            scope: 'this-and-following',
            recurrenceDate: '2026-05-04',
            remove: true,
        });

        const declined = occurrence('Moved after the cut', 3, '20260401T130000Z')
            .replace(`mailto:${GUEST}`, `mailto:${me.email}`)
            .replace('PARTSTAT=NEEDS-ACTION', 'PARTSTAT=DECLINED');
        await receiveMailed(calendar, parsedOf(declined), ORG);

        expect((await exceptionOf(calendar))?.title).toBe('Moved after the cut');
        expect(mine(await exceptionOf(calendar))).toBe('accepted');
    });

    // A date the copy holds no answer for takes the guest's answer for the series, whatever its SEQUENCE.
    test('reaches a date the organizer moves after the guest answered the series', async () => {
        const { calendar, me, mine } = await answered();
        await receiveMailed(calendar, parsedOf(request('Title A', 2, '20260401T100000Z', [], me.email)), ORG);
        await calendar.rsvp((await masterOf(calendar)).id, me, { status: 'tentative' });

        const moved = occurrence('Moved', 3, '20260401T130000Z').replace(`mailto:${GUEST}`, `mailto:${me.email}`);
        await receiveMailed(calendar, parsedOf(moved), ORG);

        expect(mine(await exceptionOf(calendar))).toBe('tentative');
    });
});

describe('an answer that names a date', () => {
    const GUESTS = [{ email: GUEST, status: 'pending' as const, role: 'required' as const }];
    const stored = async (input: { rrule?: string; timezone?: string; startTime: string; endTime: string }) => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = (await calendar.getCalendars())[0].id;
        const event = await calendar.createEvent(calendarId, {
            title: 'Answered',
            ...input,
            startTime: new Date(input.startTime),
            endTime: new Date(input.endTime),
            allDay: false,
            data: { attendees: GUESTS },
        });
        const answer = (date: string) =>
            calendar.receiveRsvpForOccurrence(event.id, GUEST, 'accepted', {
                recurrenceDate: date,
                recurrenceId: null,
            });
        const overrides = () => calendar.getEventsByUid(event.uid).then((all) => all.filter((e) => e.parentEventId));
        return { calendar, calendarId, event, answer, overrides, broadcasts: harness.broadcasts };
    };
    const MONDAYS = {
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        startTime: '2027-02-01T10:00:00Z',
        endTime: '2027-02-01T11:00:00Z',
    };

    test('adds no Wednesday to a Monday series', async () => {
        const { calendar, calendarId, event, answer, overrides } = await stored(MONDAYS);

        await answer('2027-02-10');
        await answer('2027-02-09');

        expect(await overrides()).toEqual([]);
        expect((await calendar.getEventsByUid(event.uid))[0].etag).toBe(event.etag);
        const days = await calendar.getEventsInRange(new Date('2027-02-08'), new Date('2027-02-14'), calendarId);
        expect(days.map((e) => e.occurrenceDate)).toEqual(['2027-02-08']);
    });

    test('repeated, for the series or for one date, announces nothing the second time', async () => {
        const { calendar, event, answer, broadcasts } = await stored(MONDAYS);
        await calendar.receiveAttendeeStatus(event.id, GUEST, 'accepted');
        await answer('2027-02-08');
        const announced = broadcasts.length;

        await calendar.receiveAttendeeStatus(event.id, GUEST, 'accepted');
        await answer('2027-02-08');

        expect(broadcasts).toHaveLength(announced);
    });

    test('adds no occurrence to a single event', async () => {
        const { answer, overrides } = await stored({ startTime: MONDAYS.startTime, endTime: MONDAYS.endTime });

        await answer('2027-02-10');

        expect(await overrides()).toEqual([]);
    });

    test('to a series the organizer deleted meanwhile is dropped', async () => {
        const { calendar, calendarId, event, answer } = await stored(MONDAYS);
        await calendar.deleteEvent(calendarId, event.id);

        await answer('2027-02-08');

        expect(await calendar.getEventsByUid(event.uid)).toEqual([]);
    });

    test('records the answer on a date the rule yields, at the slot the series has', async () => {
        const { answer, overrides } = await stored(MONDAYS);

        await answer('2027-02-08');

        const [override] = await overrides();
        expect(override.recurrenceDate).toBe('2027-02-08');
        expect(override.startTime).toEqual(new Date('2027-02-08T10:00:00Z'));
        expect(override.endTime).toEqual(new Date('2027-02-08T11:00:00Z'));
        expect(override.data?.attendees?.[0].status).toBe('accepted');
    });

    test('finds an occurrence whose key is the day after its UTC date', async () => {
        const { answer, overrides } = await stored({
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            timezone: 'Pacific/Kiritimati',
            startTime: '2027-01-31T10:30:00Z',
            endTime: '2027-01-31T11:30:00Z',
        });

        await answer('2027-02-08');

        const [override] = await overrides();
        expect(override.startTime).toEqual(new Date('2027-02-07T10:30:00Z'));
    });
});
