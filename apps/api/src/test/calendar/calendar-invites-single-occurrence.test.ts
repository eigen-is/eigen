// A guest invited to ONE occurrence of a series they do not hold: the message names the series plus the
// occurrence key, and the guest has no copy of that series to hang an exception on, so the occurrence
// files as a standalone event of its own. Later messages about that same occurrence — a move, a
// cancellation — find it, and an invitation to the whole series replaces it instead of twinning it.
import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getHome } from '../../lib/home';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { CALENDAR_TEST_ROOT, makeCalendar } from '../calendar-test-helpers';
import { davRequest } from '../dav-test-helpers';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, eventually, findOrFail, getTestContext } from '../setup';

const SERIES_START = '2028-03-06T09:00:00Z';
const SERIES_END = '2028-03-06T10:00:00Z';
const HOUR = 3600_000;
const TZ = 'Europe/Amsterdam';

describe('An invitation to one occurrence of a series the guest does not hold', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let bobCalendarId: string;

    beforeAll(async () => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
        ctx = await getTestContext();
        aliceCalendarId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
        bobCalendarId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
    });

    const guests = () => [{ email: ctx.bob.user.email, name: 'Bob', status: 'pending' as const, role: 'required' }];

    // A series Bob is not invited to, so his Home holds nothing under its UID.
    async function createSeries(title: string): Promise<CalendarEvent> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: SERIES_START,
                    endTime: SERIES_END,
                    allDay: false,
                    rrule: 'FREQ=WEEKLY;COUNT=4',
                    timezone: TZ,
                }),
            },
        );
        return assertJson<CalendarEvent>(res);
    }

    async function editOccurrence(
        masterId: string,
        recurrenceDate: string,
        overrides: Record<string, unknown>,
    ): Promise<CalendarEvent> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    startTime: `${recurrenceDate}T09:00:00Z`,
                    endTime: `${recurrenceDate}T10:00:00Z`,
                    allDay: false,
                    rrule: null,
                    timezone: TZ,
                    parentEventId: masterId,
                    recurrenceDate,
                    data: { attendees: guests() },
                    ...overrides,
                }),
            },
        );
        return assertJson<CalendarEvent>(res);
    }

    async function occurrencesOf(token: string, ownerId: string, uid: string): Promise<CalendarEventOccurrence[]> {
        const from = Math.floor(Date.parse('2028-02-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2028-05-01T00:00:00Z') / 1000);
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`),
        );
        return all.filter((e) => e.uid === uid).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
    }

    const bobOccurrences = (uid: string) => occurrencesOf(ctx.bob.user.sessionToken, ctx.bob.user.id, uid);
    const aliceOccurrences = (uid: string) => occurrencesOf(ctx.alice.user.sessionToken, ctx.alice.user.id, uid);

    function untilAlice(uid: string, predicate: (occurrence: CalendarEventOccurrence) => boolean) {
        return eventually(async () => {
            const one = (await aliceOccurrences(uid)).find((e) => e.occurrenceDate === TARGET);
            return one && predicate(one) ? one : undefined;
        }, "the guest's answer to reach Alice's override");
    }

    function untilBob(uid: string, predicate: (occurrences: CalendarEventOccurrence[]) => boolean) {
        return eventually(async () => {
            const occurrences = await bobOccurrences(uid);
            return predicate(occurrences) ? occurrences : undefined;
        }, "the organizer's message to reach Bob's calendar");
    }

    // Bob's stored file, read the way a CalDAV client reads it.
    async function bobStored(uid: string) {
        const home = await getHome(ctx.bob.user.id);
        const resource = findOrFail(await home.calendar.listResources(bobCalendarId), (r) => r.uid === uid);
        const res = await davRequest('GET', `/dav/calendars/${ctx.bob.user.id}/${bobCalendarId}/${resource.uri}`, {
            email: ctx.bob.user.email,
        });
        expect(res.status).toBe(200);
        return parseIcs(await res.text()).events;
    }

    // The second Monday of the series, the occurrence every test below invites Bob to.
    const TARGET = '2028-03-13';

    test('the guest sees the occurrence they were invited to', async () => {
        const series = await createSeries('Single Occurrence Visible');

        await editOccurrence(series.id, TARGET, { title: 'Just This One' });

        const occurrences = await untilBob(series.uid, (occ) => occ.length > 0);
        expect(occurrences).toHaveLength(1);
        expect(occurrences[0].title).toBe('Just This One');
        expect(occurrences[0].occurrenceDate).toBe(TARGET);
        expect(occurrences[0].rrule).toBeNull();

        const stored = await bobStored(series.uid);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('Just This One');
    });

    test("the organizer's move of that occurrence moves the guest's copy", async () => {
        const series = await createSeries('Single Occurrence Move');
        await editOccurrence(series.id, TARGET, { title: 'Before The Move' });
        await untilBob(series.uid, (occ) => occ.length === 1);

        const movedStart = new Date(Date.parse(`${TARGET}T09:00:00Z`) + HOUR);
        await editOccurrence(series.id, TARGET, {
            title: 'After The Move',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });

        const occurrences = await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'After The Move'));
        expect(occurrences).toHaveLength(1);
        expect(new Date(occurrences[0].startTime).toISOString()).toBe(movedStart.toISOString());

        const stored = await bobStored(series.uid);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('After The Move');
        expect(stored[0].startTime.toISOString()).toBe(movedStart.toISOString());
    });

    test("the organizer's cancellation of that occurrence takes the guest's copy away", async () => {
        const series = await createSeries('Single Occurrence Cancel');
        await editOccurrence(series.id, TARGET, { title: 'Doomed' });
        await untilBob(series.uid, (occ) => occ.length === 1);

        await editOccurrence(series.id, TARGET, { title: 'Doomed', status: 'cancelled' });

        const occurrences = await untilBob(series.uid, (occ) => occ.length === 0);
        expect(occurrences).toHaveLength(0);
    });

    // The copy IS the occurrence, so the answer it carries is about that occurrence and lands on the
    // organizer's override for it, never on the guestless master.
    test("the guest's answer to the single occurrence reaches the organizer's override", async () => {
        const series = await createSeries('Single Occurrence Accept');
        await editOccurrence(series.id, TARGET, { title: 'Just This One' });
        const copy = await untilBob(series.uid, (occ) => occ.length === 1);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${copy[0].id}/rsvp`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted' }),
            },
        );
        expect(res.status).toBe(200);

        const answered = await untilAlice(series.uid, (e) => e.data?.attendees?.[0]?.status === 'accepted');
        expect(answered.title).toBe('Just This One');
        // The series itself stays guestless: nothing was said about the other occurrences.
        for (const other of (await aliceOccurrences(series.uid)).filter((e) => e.occurrenceDate !== TARGET)) {
            expect(other.data?.attendees ?? []).toHaveLength(0);
        }
    });

    test("the guest's delete of the single occurrence declines it on the organizer's override", async () => {
        const series = await createSeries('Single Occurrence Decline');
        await editOccurrence(series.id, TARGET, { title: 'Not For Me' });
        const copy = await untilBob(series.uid, (occ) => occ.length === 1);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${copy[0].id}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);

        const answered = await untilAlice(series.uid, (e) => e.data?.attendees?.[0]?.status === 'declined');
        expect(answered.title).toBe('Not For Me');
    });

    test('an invitation to the whole series replaces the single occurrence instead of twinning it', async () => {
        const series = await createSeries('Single Occurrence Then Series');
        await editOccurrence(series.id, TARGET, { title: 'Only This One' });
        await untilBob(series.uid, (occ) => occ.length === 1);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Single Occurrence Then Series', data: { attendees: guests() } }),
            },
        );
        expect(res.status).toBe(200);

        const occurrences = await untilBob(
            series.uid,
            (occ) => occ.length === 4 && occ.some((e) => e.title === 'Only This One'),
        );
        // The occurrence the organizer named keeps its own title; the rest follow the series.
        expect(findOrFail(occurrences, (e) => e.occurrenceDate === TARGET).title).toBe('Only This One');
        expect(occurrences.filter((e) => e.title === 'Single Occurrence Then Series')).toHaveLength(3);
        // One resource, not two: the standalone occurrence gave way to the series.
        const home = await getHome(ctx.bob.user.id);
        const resources = (await home.calendar.listResources(bobCalendarId)).filter((r) => r.uid === series.uid);
        expect(resources).toHaveLength(1);
    });

    // A series carries its exceptions with it: a guest handed only the master would render a moved
    // occurrence at its original slot and render one the organizer deleted at all.
    const DROPPED = '2028-03-20';

    async function inviteToSeries(series: CalendarEvent): Promise<void> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: series.title, data: { attendees: guests() } }),
            },
        );
        expect(res.status).toBe(200);
    }

    test('a guest added to the whole series receives its overrides and its exclusions', async () => {
        const series = await createSeries('Series With Exceptions');
        const movedStart = new Date(Date.parse(`${TARGET}T09:00:00Z`) + 2 * HOUR);
        await editOccurrence(series.id, TARGET, {
            title: 'Series With Exceptions',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
            data: { attendees: [] },
        });
        await editOccurrence(series.id, DROPPED, {
            title: 'Series With Exceptions',
            status: 'cancelled',
            data: { attendees: [] },
        });

        await inviteToSeries(series);

        const occurrences = await untilBob(
            series.uid,
            (occ) => occ.length === 3 && occ.some((e) => new Date(e.startTime).getTime() === movedStart.getTime()),
        );
        expect(occurrences.map((e) => e.occurrenceDate)).not.toContain(DROPPED);
        expect(findOrFail(occurrences, (e) => e.occurrenceDate === TARGET).title).toBe('Series With Exceptions');

        const stored = await bobStored(series.uid);
        expect(findOrFail(stored, (e) => e.recurrenceDate === TARGET).startTime.toISOString()).toBe(
            movedStart.toISOString(),
        );
        expect(findOrFail(stored, (e) => e.recurrenceDate === DROPPED).status).toBe('cancelled');
    });

    // The organizer's list for that occurrence is authoritative, and the override that follows the series
    // carries it — so the answer the guest already gave to the occurrence stands.
    test('the series invitation keeps the answer the guest gave to the single occurrence', async () => {
        const series = await createSeries('Series After Answer');
        await editOccurrence(series.id, TARGET, { title: 'Answered' });
        const copy = await untilBob(series.uid, (occ) => occ.length === 1);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${copy[0].id}/rsvp`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted' }),
            },
        );
        expect(res.status).toBe(200);
        await untilAlice(series.uid, (e) => e.data?.attendees?.[0]?.status === 'accepted');

        await inviteToSeries(series);

        const occurrences = await untilBob(
            series.uid,
            (occ) =>
                occ.length === 4 &&
                occ.find((e) => e.occurrenceDate === TARGET)?.data?.attendees?.[0]?.status === 'accepted',
        );
        expect(findOrFail(occurrences, (e) => e.occurrenceDate === TARGET).title).toBe('Answered');
        expect(occurrences.filter((e) => e.data?.attendees?.[0]?.status === 'pending')).toHaveLength(3);
    });

    // The same message over the other transport: a lone VEVENT with a RECURRENCE-ID for a UID this Home
    // holds nothing under.
    const IMIP_UID = 'single-occurrence@external.com';
    const IMIP_ORG = 'organizer@external.com';

    const imipOccurrence = (summary: string, sequence: number, dtstamp: string): ParsedEvent =>
        parseIcs(
            vcal([
                'BEGIN:VEVENT',
                `UID:${IMIP_UID}`,
                `SUMMARY:${summary}`,
                'RECURRENCE-ID:20280313T090000Z',
                'DTSTART:20280313T110000Z',
                'DTEND:20280313T120000Z',
                `SEQUENCE:${sequence}`,
                `ORGANIZER;CN=Ext Org:mailto:${IMIP_ORG}`,
                'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@test.local',
                `DTSTAMP:${dtstamp}`,
                'END:VEVENT',
            ]),
        ).events[0];

    const imipSeries = (summary: string, sequence: number, dtstamp: string, organizer: string[]): ParsedEvent =>
        parseIcs(
            vcal([
                'BEGIN:VEVENT',
                `UID:${IMIP_UID}`,
                `SUMMARY:${summary}`,
                'DTSTART:20280306T090000Z',
                'DTEND:20280306T100000Z',
                'RRULE:FREQ=WEEKLY;COUNT=4',
                `SEQUENCE:${sequence}`,
                ...organizer,
                'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@test.local',
                `DTSTAMP:${dtstamp}`,
                'END:VEVENT',
            ]),
        ).events[0];

    test('an iMIP REQUEST for one occurrence of an unknown series files a standalone event', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;

        await calendar.receiveImipRequest(imipOccurrence('One Instance Only', 0, '20280301T100000Z'), IMIP_ORG);

        const stored = await calendar.getEventsByUid(IMIP_UID);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('One Instance Only');
        expect(stored[0].parentEventId).toBeNull();
        expect(stored[0].data?.organizerEventId).toBe(IMIP_UID);
    });

    test('an iMIP series REQUEST with no ORGANIZER leaves the single occurrence alone', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveImipRequest(imipOccurrence('One Instance Only', 0, '20280301T100000Z'), IMIP_ORG);

        await calendar.receiveImipRequest(imipSeries('Whole Series', 1, '20280302T100000Z', []), IMIP_ORG);

        const stored = await calendar.getEventsByUid(IMIP_UID);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('One Instance Only');
        expect(stored[0].rrule).toBeNull();
    });

    test('a stale iMIP series REQUEST leaves the newer single occurrence alone', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveImipRequest(imipOccurrence('One Instance Only', 3, '20280303T100000Z'), IMIP_ORG);

        const organizer = [`ORGANIZER;CN=Ext Org:mailto:${IMIP_ORG}`];
        await calendar.receiveImipRequest(imipSeries('Stale Series', 1, '20280301T100000Z', organizer), IMIP_ORG);

        const stored = await calendar.getEventsByUid(IMIP_UID);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('One Instance Only');
        expect(stored[0].rrule).toBeNull();
    });

    test('the series invitation keeps the reminder the guest set on the occurrence', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        await calendar.receiveImipRequest(imipOccurrence('One Instance Only', 0, '20280301T100000Z'), IMIP_ORG);
        const occurrenceCopy = (await calendar.getEventsByUid(IMIP_UID))[0];
        await calendar.updateEvent(occurrenceCopy.calendarId, occurrenceCopy.id, {
            data: { ...occurrenceCopy.data, reminders: [{ type: 'notification', minutes: 45 }] },
        });

        const organizer = [`ORGANIZER;CN=Ext Org:mailto:${IMIP_ORG}`];
        await calendar.receiveImipRequest(imipSeries('Whole Series', 1, '20280302T100000Z', organizer), IMIP_ORG);

        const stored = await calendar.getEventsByUid(IMIP_UID);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('Whole Series');
        expect(stored[0].data?.reminders).toEqual([{ type: 'notification', minutes: 45 }]);
    });

    // The relay carries the same REQUEST, so it is ordered by the same rule.
    test('a stale relayed series invitation leaves the newer single occurrence alone', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const payload = (title: string, sequence: number, dtstamp: string, recurrenceDate: string | null) => ({
            uid: IMIP_UID,
            recurrenceDate,
            title,
            description: null,
            location: null,
            startTime: new Date(recurrenceDate ? '2028-03-13T11:00:00Z' : '2028-03-06T09:00:00Z'),
            endTime: new Date(recurrenceDate ? '2028-03-13T12:00:00Z' : '2028-03-06T10:00:00Z'),
            allDay: false,
            rrule: recurrenceDate ? null : 'FREQ=WEEKLY;COUNT=4',
            timezone: null,
            status: 'confirmed' as const,
            sequence,
            dtstamp: new Date(dtstamp),
            data: {
                organizer: { userId: 'organizer-home', email: IMIP_ORG, name: 'Ext Org' },
                organizerEventId: 'organizer-event',
                attendees: [{ email: 'guest@test.local', status: 'pending' as const, role: 'required' as const }],
            },
            createByUserId: 'organizer-home',
            organizerEventId: 'organizer-event',
            organizerUserId: 'organizer-home',
        });
        await calendar.receiveInvitation(payload('One Instance Only', 3, '2028-03-03T10:00:00Z', '2028-03-13'));

        await calendar.receiveInvitation(payload('Stale Series', 1, '2028-03-01T10:00:00Z', null));

        const stored = await calendar.getEventsByUid(IMIP_UID);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('One Instance Only');
        expect(stored[0].rrule).toBeNull();
    });
});
