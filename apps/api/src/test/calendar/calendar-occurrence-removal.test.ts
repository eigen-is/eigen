// DELETE on one occurrence of a series: a live override is the occurrence, so deleting it drops that
// instance, and deleting the cancelled row that stands for a dropped instance puts it back.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getHome } from '../../lib/home';
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

    async function series(title: string): Promise<CalendarEvent> {
        return post({
            title,
            startTime: SERIES_START,
            endTime: '2030-01-07T10:00:00Z',
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=4',
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
});
