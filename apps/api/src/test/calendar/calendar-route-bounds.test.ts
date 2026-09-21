// A REST bound is never tighter than what a CalDAV PUT may store: the per-resource byte ceiling is the real
// bound, and anything below it would make an event a device wrote uneditable in the web app forever.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { davRequest } from '../dav-test-helpers';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, createTestUser, findOrFail, getTestContext, type TestUser } from '../setup';

// A legal RRULE nothing bounds: an ordinal BYDAY list for a yearly rule runs past 500 characters.
const LONG_RRULE = `FREQ=YEARLY;BYDAY=${Array.from({ length: 53 }, (_, i) => `${i + 1}MO,${i + 1}TU`).join(',')}`;
const LONG_TEXT = 'x'.repeat(700);

describe('the REST event bounds against what a CalDAV PUT stores', () => {
    let user: TestUser;
    let calendarId: string;

    beforeAll(async () => {
        await getTestContext();
        user = await createTestUser('cal-bounds@test.eigen.is', 'testpassword123', 'Cal Bounds');
        calendarId = findOrFail(
            await assertJson<CalendarItem[]>(await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars`)),
            (c) => c.isDefault,
        ).id;
    });

    // The reviewer's event: every free-text value past 512 characters and more guests than the REST array took.
    const attendees = Array.from(
        { length: 150 },
        (_, i) => `ATTENDEE;CN=Guest ${i};PARTSTAT=NEEDS-ACTION:mailto:guest${i}@example.com`,
    );
    // One guest whose CN and address are both longer than any bound but the resource ceiling.
    attendees.push(`ATTENDEE;CN=${LONG_TEXT}:mailto:${'l'.repeat(300)}@example.com`);
    const alarms = Array.from({ length: 60 }, () => [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Reminder',
        'TRIGGER:-PT10M',
        'END:VALARM',
    ]).flat();

    test('a device event the web app cannot re-save is not a thing', async () => {
        const uri = 'wide-event.ics';
        const put = await davRequest('PUT', `/dav/calendars/${user.id}/${calendarId}/${uri}`, {
            email: user.email,
            headers: { 'Content-Type': 'text/calendar' },
            body: vcal([
                'BEGIN:VEVENT',
                'UID:wide-event@device',
                `SUMMARY:${LONG_TEXT}`,
                `LOCATION:${LONG_TEXT}`,
                `URL:https://example.com/${LONG_TEXT}`,
                'DTSTART:20280306T090000Z',
                'DTEND:20280306T100000Z',
                `RRULE:${LONG_RRULE}`,
                'DTSTAMP:20280301T100000Z',
                ...attendees,
                ...alarms,
                'END:VEVENT',
            ]),
        });
        expect(put.status).toBe(201);

        const from = Math.floor(Date.parse('2028-03-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2028-03-10T00:00:00Z') / 1000);
        const stored = findOrFail(
            await assertJson<CalendarEventOccurrence[]>(
                await authedRequest(user.sessionToken, `/calendar/${user.id}/event-range/${from}/${to}`),
            ),
            (e) => e.uid === 'wide-event@device',
        );
        expect(stored.title.length).toBe(700);
        expect(stored.rrule!.length).toBeGreaterThan(512);
        expect(stored.data?.attendees).toHaveLength(151);
        expect(stored.data?.reminders).toHaveLength(60);

        // The web app's own save: the row as it was loaded, with one field edited.
        const res = await authedRequest(
            user.sessionToken,
            `/calendar/${user.id}/calendars/${calendarId}/events/${stored.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: stored.title,
                    startTime: stored.startTime,
                    endTime: stored.endTime,
                    allDay: stored.allDay,
                    description: 'Edited in the web app',
                    location: stored.location,
                    rrule: stored.rrule,
                    timezone: stored.timezone,
                    data: stored.data,
                }),
            },
        );
        const saved = await assertJson<CalendarEvent>(res);
        expect(saved.description).toBe('Edited in the web app');
        expect(saved.rrule).toBe(stored.rrule);
        expect(saved.title).toBe(stored.title);
        expect(saved.data?.attendees).toHaveLength(151);
        expect(saved.data?.attendees?.at(-1)?.email.length).toBe(312);
        expect(saved.data?.reminders).toHaveLength(60);
    });
});
