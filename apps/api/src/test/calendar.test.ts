import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

describe('Calendar', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let aliceEventId: string;
    let aliceRecurringEventId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('Calendar CRUD', () => {
        test('init creates default Personal calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            expect(res.status).toBe(200);
            const calendars = await res.json() as any[];
            expect(calendars.length).toBeGreaterThanOrEqual(1);
            const personal = calendars.find((c: any) => c.isDefault === true);
            expect(personal).toBeDefined();
            expect(personal.name).toBe('Personal');
            aliceCalendarId = personal.id;
        });

        test('create calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'Work', color: '#34a853'}),
                });
            expect(res.status).toBe(200);
            const cal = await res.json() as any;
            expect(cal.name).toBe('Work');
            expect(cal.color).toBe('#34a853');
            expect(cal.isDefault).toBe(false);
            expect(cal.id).toBeDefined();
        });

        test('list calendars includes new calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars = await res.json() as any[];
            expect(calendars.length).toBeGreaterThanOrEqual(2);
            expect(calendars.find((c: any) => c.name === 'Work')).toBeDefined();
        });

        test('update calendar name and color', async () => {
            const listRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars = await listRes.json() as any[];
            const work = calendars.find((c: any) => c.name === 'Work');

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${work.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'Work Projects', color: '#4285f4'}),
                });
            expect(res.status).toBe(200);
            const updated = await res.json() as any;
            expect(updated.name).toBe('Work Projects');
            expect(updated.color).toBe('#4285f4');
        });

        test('delete non-default calendar succeeds', async () => {
            const listRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars = await listRes.json() as any[];
            const work = calendars.find((c: any) => c.name === 'Work Projects');

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${work.id}`, {method: 'DELETE'});
            expect(res.status).toBe(200);

            const listRes2 = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars2 = await listRes2.json() as any[];
            expect(calendars2.find((c: any) => c.name === 'Work Projects')).toBeUndefined();
        });

        test('delete default calendar fails', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`, {method: 'DELETE'});
            expect(res.status).toBe(400);
        });
    });

    describe('Event CRUD', () => {
        test('create event with all fields', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Team Standup',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        description: 'Daily sync',
                        location: 'Room A',
                        data: {reminders: [{type: 'notification', minutes: 10}]},
                    }),
                });
            expect(res.status).toBe(200);
            const event = await res.json() as any;
            expect(event.title).toBe('Team Standup');
            expect(event.description).toBe('Daily sync');
            expect(event.location).toBe('Room A');
            expect(event.startTime).toBe(1741773600);
            expect(event.endTime).toBe(1741777200);
            expect(event.allDay).toBe(false);
            expect(event.status).toBe('confirmed');
            expect(event.uid).toBeDefined();
            expect(event.uri).toContain('.ics');
            expect(event.data.reminders).toHaveLength(1);
            aliceEventId = event.id;
        });

        test('create event with minimal fields', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Lunch',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                });
            expect(res.status).toBe(200);
            const event = await res.json() as any;
            expect(event.title).toBe('Lunch');
            expect(event.description).toBeNull();
            expect(event.location).toBeNull();
            expect(event.status).toBe('confirmed');
        });

        test('create all-day event', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Company Holiday',
                        startTime: 1741737600,
                        endTime: 1741824000,
                        allDay: true,
                    }),
                });
            expect(res.status).toBe(200);
            const event = await res.json() as any;
            expect(event.allDay).toBe(true);
        });

        test('update event partially', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events/${aliceEventId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({title: 'Team Standup (updated)', location: 'Room B'}),
                });
            expect(res.status).toBe(200);
            const event = await res.json() as any;
            expect(event.title).toBe('Team Standup (updated)');
            expect(event.location).toBe('Room B');
            expect(event.description).toBe('Daily sync');
        });

        test('etag changes on update', async () => {
            const res1 = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events/${aliceEventId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({title: 'Team Standup v2'}),
                });
            const event1 = await res1.json() as any;
            const etag1 = event1.etag;

            const res2 = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events/${aliceEventId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({title: 'Team Standup v3'}),
                });
            const event2 = await res2.json() as any;
            expect(event2.etag).not.toBe(etag1);
        });

        test('delete event', async () => {
            const createRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'To Delete',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                });
            const created = await createRes.json() as any;

            const delRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events/${created.id}`, {method: 'DELETE'});
            expect(delRes.status).toBe(200);

            const rangeRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events?from=1741737600&to=1741824000`);
            const events = await rangeRes.json() as any[];
            expect(events.find((e: any) => e.id === created.id)).toBeUndefined();
        });
    });

    describe('RRULE storage and round-trip', () => {
        test('create recurring event with RRULE string and get it back', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Weekly Sync',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=WE',
                    }),
                });
            expect(res.status).toBe(200);
            const event = await res.json() as any;
            expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
            aliceRecurringEventId = event.id;
        });

        test('monthly recurrence with BYMONTHDAY', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Monthly Review',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12',
                    }),
                });
            const event = await res.json() as any;
            expect(event.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12');
        });

        test('daily with interval', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Every 3 Days',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=DAILY;INTERVAL=3',
                    }),
                });
            const event = await res.json() as any;
            expect(event.rrule).toBe('FREQ=DAILY;INTERVAL=3');
        });

        test('complex RRULE with BYSETPOS (last Friday)', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Last Friday',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
                    }),
                });
            const event = await res.json() as any;
            expect(event.rrule).toBe('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
        });

        test('RRULE with BYHOUR/BYMINUTE survives round-trip (CalDAV readiness)', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'CalDAV Complex',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30',
                    }),
                });
            const event = await res.json() as any;
            expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30');
        });

        test('non-recurring event has null rrule', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'One-off Meeting',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                });
            const event = await res.json() as any;
            expect(event.rrule).toBeNull();
        });
    });

    describe('Recurrence expansion', () => {
        test('weekly recurring event expands in range', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
            expect(res.status).toBe(200);
            const events = await res.json() as any[];
            const weeklySyncs = events.filter((e: any) => e.title === 'Weekly Sync');
            expect(weeklySyncs.length).toBeGreaterThanOrEqual(2);
            for (const e of weeklySyncs) {
                expect(e.occurrenceDate).toBeDefined();
            }
        });

        test('events outside range are excluded', async () => {
            const from = 1;
            const to = 100;
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
            const events = await res.json() as any[];
            expect(events.length).toBe(0);
        });
    });

    describe('Recurrence exceptions', () => {
        test('cancel a single occurrence', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            const beforeRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
            const beforeEvents = await beforeRes.json() as any[];
            const weeklySyncs = beforeEvents.filter((e: any) => e.title === 'Weekly Sync');
            const targetDate = weeklySyncs[1]?.occurrenceDate;

            if (targetDate) {
                const cancelRes = await authedRequest(ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            title: 'Weekly Sync',
                            startTime: weeklySyncs[1].startTime,
                            endTime: weeklySyncs[1].endTime,
                            allDay: false,
                            parentEventId: aliceRecurringEventId,
                            recurrenceDate: targetDate,
                            status: 'cancelled',
                        }),
                    });
                expect(cancelRes.status).toBe(200);

                const afterRes = await authedRequest(ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
                const afterEvents = await afterRes.json() as any[];
                const afterSyncs = afterEvents.filter((e: any) =>
                    e.title === 'Weekly Sync' && e.occurrenceDate === targetDate && !e.parentEventId);
                expect(afterSyncs.length).toBe(0);
            }
        });

        test('modify a single occurrence', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            const beforeRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
            const beforeEvents = await beforeRes.json() as any[];
            const weeklySyncs = beforeEvents.filter((e: any) =>
                e.title === 'Weekly Sync' && !e.parentEventId);
            const first = weeklySyncs[0];

            if (first) {
                const modRes = await authedRequest(ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            title: 'Weekly Sync (moved)',
                            startTime: first.startTime + 3600,
                            endTime: first.endTime + 3600,
                            allDay: false,
                            parentEventId: aliceRecurringEventId,
                            recurrenceDate: first.occurrenceDate,
                        }),
                    });
                expect(modRes.status).toBe(200);

                const afterRes = await authedRequest(ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events?from=${from}&to=${to}`);
                const afterEvents = await afterRes.json() as any[];
                const modified = afterEvents.find((e: any) => e.title === 'Weekly Sync (moved)');
                expect(modified).toBeDefined();
                expect(modified.startTime).toBe(first.startTime + 3600);
            }
        });
    });

    describe('Range queries', () => {
        test('missing from/to returns 400', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events`);
            expect(res.status).toBe(400);
        });

        test('empty range returns empty array', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events?from=1000000000&to=1000000001`);
            expect(res.status).toBe(200);
            const events = await res.json() as any[];
            expect(events.length).toBe(0);
        });

        test('range query returns events in range', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/events?from=1741737600&to=1741824000`);
            expect(res.status).toBe(200);
            const events = await res.json() as any[];
            expect(events.length).toBeGreaterThan(0);
        });
    });

    describe('Sharing', () => {
        let sharedCalendarId: string;

        test('share calendar with Bob', async () => {
            const createRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: 'Shared Cal', color: '#ea4335'}),
                });
            const cal = await createRes.json() as any;
            sharedCalendarId = cal.id;

            const createEventRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Shared Event',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                });
            expect(createEventRes.status).toBe(200);

            const shareRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        shares: [{targetId: ctx.bob.user.email, permission: 'read'}],
                    }),
                });
            expect(shareRes.status).toBe(200);
        });

        test('Bob sees shared calendar in shared list', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/shared`);
            expect(res.status).toBe(200);
            const shared = await res.json() as any[];
            const found = shared.find((s: any) => s.calendarId === sharedCalendarId);
            expect(found).toBeDefined();
            expect(found.calendarName).toBe('Shared Cal');
            expect(found.permission).toBe('read');
        });

        test('Bob can read events from shared calendar', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events?from=1741737600&to=1741824000`);
            expect(res.status).toBe(200);
            const events = await res.json() as any[];
            expect(events.length).toBeGreaterThan(0);
            expect(events[0].title).toBe('Shared Event');
        });

        test('Bob cannot write to read-only shared calendar', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Bob Event',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                });
            expect(res.status).toBe(403);
        });

        test('Charlie has no access to shared calendar', async () => {
            const res = await authedRequest(ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events?from=1741737600&to=1741824000`);
            expect(res.status).toBe(403);
        });

        test('upgrade Bob to write permission', async () => {
            const shareRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        shares: [{targetId: ctx.bob.user.email, permission: 'write'}],
                    }),
                });
            expect(shareRes.status).toBe(200);

            const writeRes = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Bob Event',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                });
            expect(writeRes.status).toBe(200);
            const event = await writeRes.json() as any;
            expect(event.title).toBe('Bob Event');
        });

        test('free-busy permission returns only time blocks', async () => {
            const shareRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        shares: [
                            {targetId: ctx.bob.user.email, permission: 'write'},
                            {targetId: ctx.charlie.user.email, permission: 'free-busy'},
                        ],
                    }),
                });
            expect(shareRes.status).toBe(200);

            const res = await authedRequest(ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events?from=1741737600&to=1741824000`);
            expect(res.status).toBe(200);
            const blocks = await res.json() as any[];
            expect(blocks.length).toBeGreaterThan(0);
            expect(blocks[0].startTime).toBeDefined();
            expect(blocks[0].endTime).toBeDefined();
            expect(blocks[0].title).toBeUndefined();
            expect(blocks[0].description).toBeUndefined();
        });

        test('unshare removes from Bob shared list', async () => {
            await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({shares: []}),
                });

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/shared`);
            const shared = await res.json() as any[];
            expect(shared.find((s: any) => s.calendarId === sharedCalendarId)).toBeUndefined();
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob calendars are separate from Alice', async () => {
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`);
            const aliceCals = await aliceRes.json() as any[];

            const bobRes = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCals = await bobRes.json() as any[];

            const aliceIds = new Set(aliceCals.map((c: any) => c.id));
            const bobIds = new Set(bobCals.map((c: any) => c.id));
            const overlap = [...aliceIds].filter(id => bobIds.has(id));
            expect(overlap.length).toBe(0);
        });
    });
});
