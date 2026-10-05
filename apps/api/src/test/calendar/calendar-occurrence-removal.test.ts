// DELETE on one occurrence of a series: a live override is the occurrence, so deleting it drops that
// instance, and deleting the cancelled row that stands for a dropped instance puts it back.
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import * as propagation from '../../lib/calendar/invite-propagation';
import { getHome } from '../../lib/home';
import { davRequest } from '../dav-test-helpers';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, findOrFail, getTestContext } from '../setup';

const FROM = Math.floor(Date.parse('2030-01-01T00:00:00Z') / 1000);
const TO = Math.floor(Date.parse('2030-03-01T00:00:00Z') / 1000);
const SERIES_START = '2030-01-07T09:00:00Z';
const TARGET = '2030-01-14';

describe('Removing one occurrence of a series', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        calendarId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
    });

    const eventsUrl = () => `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/events`;

    async function post(body: Record<string, unknown>): Promise<CalendarEvent> {
        return assertJson<CalendarEvent>(
            await authedRequest(ctx.alice.user.sessionToken, eventsUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        );
    }

    async function occurrencesOf(uid: string): Promise<CalendarEventOccurrence[]> {
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/event-range/${FROM}/${TO}`,
            ),
        );
        return all.filter((e) => e.uid === uid);
    }

    async function deleteEvent(id: string): Promise<void> {
        const res = await authedRequest(ctx.alice.user.sessionToken, `${eventsUrl()}/${id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
    }

    async function series(title: string, data?: object): Promise<CalendarEvent> {
        return post({
            title,
            startTime: SERIES_START,
            endTime: '2030-01-07T10:00:00Z',
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=4',
            data,
        });
    }

    async function moveTarget(parent: CalendarEvent, title: string): Promise<CalendarEvent> {
        return post({
            title,
            startTime: `${TARGET}T11:00:00Z`,
            endTime: `${TARGET}T12:00:00Z`,
            allDay: false,
            parentEventId: parent.id,
            recurrenceDate: TARGET,
        });
    }

    test('deleting a moved occurrence drops that instance', async () => {
        const parent = await series('Occurrence Delete Live');
        const override = await moveTarget(parent, 'Occurrence Delete Live (moved)');
        expect(await occurrencesOf(parent.uid)).toHaveLength(4);

        await deleteEvent(override.id);

        const remaining = await occurrencesOf(parent.uid);
        expect(remaining).toHaveLength(3);
        expect(remaining.find((e) => e.occurrenceDate === TARGET)).toBeUndefined();
    });

    // The web app's "Delete this" on a moved occurrence is an update to `cancelled`. Stored as a STATUS:CANCELLED
    // override, Thunderbird would drop that VEVENT from its next PUT and bring the occurrence back.
    test('cancelling a moved occurrence stores an EXDATE, not a cancelled override', async () => {
        const parent = await series('Occurrence Cancel Moved');
        const override = await moveTarget(parent, 'Occurrence Cancel Moved (moved)');

        const res = await authedRequest(ctx.alice.user.sessionToken, `${eventsUrl()}/${override.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'cancelled' }),
        });
        expect((await assertJson<CalendarEvent>(res)).status).toBe('cancelled');

        const remaining = await occurrencesOf(parent.uid);
        expect(remaining).toHaveLength(3);
        expect(remaining.find((e) => e.occurrenceDate === TARGET)).toBeUndefined();
        const home = await getHome(ctx.alice.user.id);
        const resource = findOrFail(await home.calendar.listResources(calendarId), (r) => r.uid === parent.uid);
        const get = await davRequest('GET', `/dav/calendars/${ctx.alice.user.id}/${calendarId}/${resource.uri}`, {
            email: ctx.alice.user.email,
        });
        const ics = await get.text();
        expect(ics).toContain(`EXDATE:${TARGET.replace(/-/g, '')}T090000Z`);
        expect(ics).not.toContain('RECURRENCE-ID');
        expect(ics).not.toContain('STATUS:CANCELLED');

        // The cancelled row keeps the override's id, so deleting it puts the occurrence back.
        await deleteEvent(override.id);
        expect(await occurrencesOf(parent.uid)).toHaveLength(4);
    });

    test('deleting the cancelled row of a dropped occurrence puts it back', async () => {
        const parent = await series('Occurrence Delete Cancelled');
        await post({
            title: 'Occurrence Delete Cancelled',
            startTime: `${TARGET}T09:00:00Z`,
            endTime: `${TARGET}T10:00:00Z`,
            allDay: false,
            parentEventId: parent.id,
            recurrenceDate: TARGET,
            status: 'cancelled',
        });
        expect(await occurrencesOf(parent.uid)).toHaveLength(3);

        const home = await getHome(ctx.alice.user.id);
        const cancelled = findOrFail(
            await home.calendar.getEventsByUid(parent.uid),
            (e) => e.status === 'cancelled' && e.recurrenceDate === TARGET,
        );
        await deleteEvent(cancelled.id);

        const restored = await occurrencesOf(parent.uid);
        expect(restored).toHaveLength(4);
        expect(findOrFail(restored, (e) => e.occurrenceDate === TARGET).title).toBe('Occurrence Delete Cancelled');
    });

    // Putting an occurrence back cancels nothing, so the series' guests get no CANCEL for it.
    test('putting a dropped occurrence back sends its guests no cancellation', async () => {
        const parent = await series('Occurrence Restore Guests', {
            attendees: [{ email: 'carol.restore@example.org', name: 'Carol', status: 'pending', role: 'required' }],
        });
        await post({
            title: 'Occurrence Restore Guests',
            startTime: `${TARGET}T09:00:00Z`,
            endTime: `${TARGET}T10:00:00Z`,
            allDay: false,
            parentEventId: parent.id,
            recurrenceDate: TARGET,
            status: 'cancelled',
        });
        const home = await getHome(ctx.alice.user.id);
        const cancelled = findOrFail(
            await home.calendar.getEventsByUid(parent.uid),
            (e) => e.status === 'cancelled' && e.recurrenceDate === TARGET,
        );

        const spy = spyOn(propagation, 'propagateCancellation').mockResolvedValue();
        spy.mockClear();
        await deleteEvent(cancelled.id);
        const cancellations = spy.mock.calls.length;
        spy.mockRestore();

        expect(cancellations).toBe(0);
        expect(await occurrencesOf(parent.uid)).toHaveLength(4);
    });

    // A client may cancel an occurrence as a STATUS:CANCELLED override instead of an EXDATE. Deleting that
    // row puts the occurrence back, exactly as deleting an EXDATE-cancelled one does.
    test("deleting a client's cancelled override puts the occurrence back", async () => {
        const uid = 'client-cancelled-override@device';
        const put = await davRequest('PUT', `/dav/calendars/${ctx.alice.user.id}/${calendarId}/cancelled.ics`, {
            email: ctx.alice.user.email,
            headers: { 'Content-Type': 'text/calendar' },
            body: vcal(
                [
                    'BEGIN:VEVENT',
                    `UID:${uid}`,
                    'SUMMARY:Client Cancelled Override',
                    'DTSTART:20300107T090000Z',
                    'DTEND:20300107T100000Z',
                    'RRULE:FREQ=WEEKLY;COUNT=4',
                    'DTSTAMP:20300101T100000Z',
                    'END:VEVENT',
                ],
                [
                    'BEGIN:VEVENT',
                    `UID:${uid}`,
                    'SUMMARY:Client Cancelled Override',
                    `RECURRENCE-ID:${TARGET.replace(/-/g, '')}T090000Z`,
                    `DTSTART:${TARGET.replace(/-/g, '')}T090000Z`,
                    `DTEND:${TARGET.replace(/-/g, '')}T100000Z`,
                    'STATUS:CANCELLED',
                    'DTSTAMP:20300101T100000Z',
                    'END:VEVENT',
                ],
            ),
        });
        expect(put.status).toBe(201);
        expect(await occurrencesOf(uid)).toHaveLength(3);

        const home = await getHome(ctx.alice.user.id);
        const cancelled = findOrFail(
            await home.calendar.getEventsByUid(uid),
            (e) => e.status === 'cancelled' && e.recurrenceDate === TARGET,
        );
        await deleteEvent(cancelled.id);

        const restored = await occurrencesOf(uid);
        expect(restored).toHaveLength(4);
        expect(findOrFail(restored, (e) => e.occurrenceDate === TARGET).title).toBe('Client Cancelled Override');
        // The occurrence is the master's expansion again, so no row of its own survives — as an EXDATE restore leaves none.
        expect((await home.calendar.getEventsByUid(uid)).filter((e) => e.parentEventId)).toHaveLength(0);
    });
});
