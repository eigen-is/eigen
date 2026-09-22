// What an organizer's removals owe the guests: dropping the last name on the list cancels their copy
// just as dropping one of several does, and a cancelled occurrence says so in the notification centre.
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getHome } from '../../lib/home';
import { assertJson, authedRequest, eventually, findOrFail, getTestContext } from '../setup';

const SERIES_START = '2029-04-02T09:00:00Z';
const SERIES_END = '2029-04-02T10:00:00Z';
const TARGET = '2029-04-09';

describe('Cancellations reaching the guest', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        aliceCalendarId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
    });

    const guests = () => [{ email: ctx.bob.user.email, name: 'Bob', status: 'pending' as const, role: 'required' }];

    async function post(body: Record<string, unknown>): Promise<CalendarEvent> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        return assertJson<CalendarEvent>(res);
    }

    async function put(id: string, body: Record<string, unknown>): Promise<void> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${id}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
        expect(res.status).toBe(200);
    }

    async function bobOccurrences(uid: string): Promise<CalendarEventOccurrence[]> {
        const from = Math.floor(Date.parse('2029-03-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2029-06-01T00:00:00Z') / 1000);
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`),
        );
        return all.filter((e) => e.uid === uid);
    }

    function untilBob(uid: string, predicate: (occurrences: CalendarEventOccurrence[]) => boolean) {
        return eventually(async () => {
            const occurrences = await bobOccurrences(uid);
            return predicate(occurrences) ? occurrences : undefined;
        }, "the organizer's message to reach Bob's calendar");
    }

    test("removing the last attendee cancels the guest's copy", async () => {
        const event = await post({
            title: 'Last Attendee Removed',
            startTime: SERIES_START,
            endTime: SERIES_END,
            allDay: false,
            data: { attendees: guests() },
        });
        await untilBob(event.uid, (occ) => occ.length === 1);

        await put(event.id, { title: 'Last Attendee Removed', data: { attendees: [] } });

        expect(await untilBob(event.uid, (occ) => occ.length === 0)).toHaveLength(0);
    });

    test('a cancelled occurrence tells the guest which instance went', async () => {
        const series = await post({
            title: 'Occurrence Cancel Notice',
            startTime: SERIES_START,
            endTime: SERIES_END,
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=4',
            data: { attendees: guests() },
        });
        await untilBob(series.uid, (occ) => occ.length === 4);

        const bobHome = await getHome(ctx.bob.user.id);
        const persist = spyOn(bobHome.notifications!, 'persist');
        persist.mockClear();

        await post({
            title: 'Occurrence Cancel Notice',
            startTime: `${TARGET}T09:00:00Z`,
            endTime: `${TARGET}T10:00:00Z`,
            allDay: false,
            rrule: null,
            parentEventId: series.id,
            recurrenceDate: TARGET,
            status: 'cancelled',
        });
        await untilBob(series.uid, (occ) => occ.length === 3);

        const calls = persist.mock.calls.map((call) => call[0]).filter((n) => n.type.startsWith('calendar-invite'));
        persist.mockRestore();
        expect(calls.map((n) => n.type)).toContain('calendar-invite-cancelled');
        const cancelled = findOrFail(calls, (n) => n.type === 'calendar-invite-cancelled');
        expect(cancelled.body).toContain('Occurrence Cancel Notice');
        // The instance that went, not the series: the tag the notification links through names its instant.
        expect(cancelled.tag).toBe(`calendar-invite:${series.id}:${Date.parse(`${TARGET}T09:00:00Z`)}`);
    });
});
