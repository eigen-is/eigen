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

    async function bobOccurrences(uid: string): Promise<CalendarEventOccurrence[]> {
        const from = Math.floor(Date.parse('2028-02-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2028-05-01T00:00:00Z') / 1000);
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`),
        );
        return all.filter((e) => e.uid === uid).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
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

        const occurrences = await untilBob(series.uid, (occ) => occ.length === 4);
        expect(occurrences.every((e) => e.title === 'Single Occurrence Then Series')).toBe(true);
        // One resource, not two: the standalone occurrence gave way to the series.
        const home = await getHome(ctx.bob.user.id);
        const resources = (await home.calendar.listResources(bobCalendarId)).filter((r) => r.uid === series.uid);
        expect(resources).toHaveLength(1);
    });

    // The same message over the other transport: a lone VEVENT with a RECURRENCE-ID for a UID this Home
    // holds nothing under.
    test('an iMIP REQUEST for one occurrence of an unknown series files a standalone event', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const uid = 'single-occurrence@external.com';
        const organizer = 'organizer@external.com';
        const ics = vcal([
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:One Instance Only',
            'RECURRENCE-ID:20280313T090000Z',
            'DTSTART:20280313T110000Z',
            'DTEND:20280313T120000Z',
            'SEQUENCE:0',
            `ORGANIZER;CN=Ext Org:mailto:${organizer}`,
            'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@test.local',
            'DTSTAMP:20280301T100000Z',
            'END:VEVENT',
        ]);
        const parsed: ParsedEvent = parseIcs(ics).events[0];

        await calendar.receiveImipRequest(parsed, organizer);

        const stored = await calendar.getEventsByUid(uid);
        expect(stored).toHaveLength(1);
        expect(stored[0].title).toBe('One Instance Only');
        expect(stored[0].parentEventId).toBeNull();
        expect(stored[0].data?.organizerEventId).toBe(uid);
    });
});
