// One occurrence of an invited series, over the Home relay: the organizer's "this event" edit must reach
// the guest as an exception on their linked series — never as an update of the whole series — and the
// same for a second edit, a cancellation and a guest's RSVP. Driven through the routes the calendar app
// calls (docs/CALENDAR.md § Invitations).
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getHome } from '../../lib/home';
import { parseIcs } from '../../lib/ical';
import { davRequest } from '../dav-test-helpers';
import { assertJson, authedRequest, eventually, findOrFail, getTestContext } from '../setup';

const SERIES_START = '2027-02-02T09:00:00Z';
const SERIES_END = '2027-02-02T10:00:00Z';
const HOUR = 3600_000;
const TZ = 'Europe/Amsterdam';

describe('Occurrence edits of an invited series', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let bobCalendarId: string;

    beforeAll(async () => {
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
                    data: { attendees: guests() },
                }),
            },
        );
        return assertJson<CalendarEvent>(res);
    }

    // What the calendar app posts for "this event": a create carrying the master's id plus the occurrence key.
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
                    startTime: SERIES_START,
                    endTime: SERIES_END,
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
        const from = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2027-04-01T00:00:00Z') / 1000);
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`),
        );
        return all.filter((e) => e.uid === uid).sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
    }

    const bobOccurrences = (uid: string) => occurrencesOf(ctx.bob.user.sessionToken, ctx.bob.user.id, uid);
    const aliceOccurrences = (uid: string) => occurrencesOf(ctx.alice.user.sessionToken, ctx.alice.user.id, uid);

    function untilBob(uid: string, predicate: (occurrences: CalendarEventOccurrence[]) => boolean) {
        return eventually(async () => {
            const occurrences = await bobOccurrences(uid);
            return predicate(occurrences) ? occurrences : undefined;
        }, "the organizer's message to reach Bob's calendar");
    }

    // Bob's stored resource, read the way a CalDAV client reads it.
    async function bobIcs(uid: string): Promise<string> {
        const home = await getHome(ctx.bob.user.id);
        const resource = findOrFail(await home.calendar.listResources(bobCalendarId), (r) => r.uid === uid);
        const res = await davRequest('GET', `/dav/calendars/${ctx.bob.user.id}/${bobCalendarId}/${resource.uri}`, {
            email: ctx.bob.user.email,
        });
        expect(res.status).toBe(200);
        return res.text();
    }

    async function bobStored(uid: string) {
        const { events } = parseIcs(await bobIcs(uid));
        return {
            master: findOrFail(events, (e) => !e.recurrenceDate),
            overrides: events.filter((e) => e.recurrenceDate),
        };
    }

    async function seeded(title: string): Promise<{ series: CalendarEvent; target: string }> {
        const series = await createSeries(title);
        const reached = await untilBob(series.uid, (occ) => occ.length === 4);
        return { series, target: reached[1].occurrenceDate };
    }

    test('moving one occurrence moves that occurrence on the guest and leaves the series alone', async () => {
        const { series, target } = await seeded('Weekly Occurrence Move');

        await editOccurrence(series.id, target, {
            title: 'Moved Standup',
            startTime: new Date(Date.parse(`${target}T09:00:00Z`) + HOUR),
            endTime: new Date(Date.parse(`${target}T10:00:00Z`) + HOUR),
        });

        const occurrences = await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Moved Standup'));
        expect(occurrences).toHaveLength(4);
        const moved = findOrFail(occurrences, (e) => e.occurrenceDate === target);
        expect(moved.title).toBe('Moved Standup');
        expect(new Date(moved.startTime).toISOString()).toBe(new Date(Date.parse(`${target}T10:00:00Z`)).toISOString());

        // Every other occurrence keeps the series' own title and 09:00 slot.
        for (const other of occurrences.filter((e) => e.occurrenceDate !== target)) {
            expect(other.title).toBe('Weekly Occurrence Move');
            expect(new Date(other.startTime).toISOString().substring(11)).toBe('09:00:00.000Z');
        }

        const { master, overrides } = await bobStored(series.uid);
        expect(master.title).toBe('Weekly Occurrence Move');
        expect(master.startTime.toISOString()).toBe(new Date(SERIES_START).toISOString());
        expect(master.rrule).toContain('WEEKLY');
        expect(overrides).toHaveLength(1);
        expect(overrides[0].recurrenceDate).toBe(target);
        expect(overrides[0].title).toBe('Moved Standup');
    });

    test('a second edit of the same occurrence reaches the guest as that occurrence', async () => {
        const { series, target } = await seeded('Weekly Occurrence Twice');
        const movedStart = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);

        await editOccurrence(series.id, target, {
            title: 'First Rename',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'First Rename'));

        await editOccurrence(series.id, target, {
            title: 'Second Rename',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Second Rename'));

        const laterStart = new Date(movedStart.getTime() + HOUR);
        await editOccurrence(series.id, target, {
            title: 'Second Rename',
            startTime: laterStart,
            endTime: new Date(laterStart.getTime() + HOUR),
        });

        const occurrences = await untilBob(series.uid, (occ) =>
            occ.some((e) => new Date(e.startTime).getTime() === laterStart.getTime()),
        );
        expect(occurrences).toHaveLength(4);
        const { master, overrides } = await bobStored(series.uid);
        expect(master.title).toBe('Weekly Occurrence Twice');
        expect(master.startTime.toISOString()).toBe(new Date(SERIES_START).toISOString());
        expect(overrides).toHaveLength(1);
        expect(overrides[0].title).toBe('Second Rename');
        expect(overrides[0].startTime.toISOString()).toBe(laterStart.toISOString());
    });

    test('cancelling one occurrence drops that occurrence for the guest only', async () => {
        const { series, target } = await seeded('Weekly Occurrence Cancel');

        await editOccurrence(series.id, target, { title: 'Weekly Occurrence Cancel', status: 'cancelled' });

        const occurrences = await untilBob(series.uid, (occ) => occ.length === 3);
        expect(occurrences.some((e) => e.occurrenceDate === target)).toBe(false);
        const { master } = await bobStored(series.uid);
        expect(master.title).toBe('Weekly Occurrence Cancel');
        expect(master.startTime.toISOString()).toBe(new Date(SERIES_START).toISOString());
    });

    test('a series-wide edit after an occurrence edit keeps the override and moves the master', async () => {
        const { series, target } = await seeded('Weekly Occurrence Then Series');
        const movedStart = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);

        await editOccurrence(series.id, target, {
            title: 'Only This One',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Only This One'));

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Series Renamed', data: { attendees: guests() } }),
            },
        );
        expect(res.status).toBe(200);

        const occurrences = await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Series Renamed'));
        expect(occurrences).toHaveLength(4);
        expect(findOrFail(occurrences, (e) => e.occurrenceDate === target).title).toBe('Only This One');
        expect(occurrences.filter((e) => e.title === 'Series Renamed')).toHaveLength(3);
    });

    // A series-wide edit carries the fields an occurrence never claimed for itself: one that was only
    // MOVED takes the new title and keeps its slot, for the organizer and for every guest. Times never follow.
    test('a series-wide rename reaches an occurrence that was only moved', async () => {
        const { series, target } = await seeded('Weekly Occurrence Inherit');
        const movedStart = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);

        await editOccurrence(series.id, target, {
            title: 'Weekly Occurrence Inherit',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => new Date(e.startTime).getTime() === movedStart.getTime()));

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'All Events', data: { attendees: guests() } }),
            },
        );
        expect(res.status).toBe(200);

        const mine = await aliceOccurrences(series.uid);
        expect(mine.filter((e) => e.title === 'All Events')).toHaveLength(4);
        expect(new Date(findOrFail(mine, (e) => e.occurrenceDate === target).startTime).toISOString()).toBe(
            movedStart.toISOString(),
        );

        const theirs = await untilBob(series.uid, (occ) => occ.every((e) => e.title === 'All Events'));
        expect(theirs).toHaveLength(4);
        expect(new Date(findOrFail(theirs, (e) => e.occurrenceDate === target).startTime).toISOString()).toBe(
            movedStart.toISOString(),
        );
        const { overrides } = await bobStored(series.uid);
        expect(overrides).toHaveLength(1);
        expect(overrides[0].title).toBe('All Events');
    });

    test("the guest's RSVP to the edited occurrence lands on the organizer's occurrence only", async () => {
        const { series, target } = await seeded('Weekly Occurrence RSVP');
        const movedStart = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);

        await editOccurrence(series.id, target, {
            title: 'Moved For RSVP',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Moved For RSVP'));

        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        const rsvpRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${bobMaster.id}/rsvp`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted', scope: 'this', recurrenceDate: target }),
            },
        );
        expect(rsvpRes.status).toBe(200);

        const accepted = await eventually(async () => {
            const occ = await aliceOccurrences(series.uid);
            const one = occ.find((e) => e.occurrenceDate === target);
            return one?.data?.attendees?.[0]?.status === 'accepted' ? occ : undefined;
        }, "the RSVP to reach Alice's occurrence");
        expect(findOrFail(accepted, (e) => e.occurrenceDate === target).title).toBe('Moved For RSVP');
        for (const other of accepted.filter((e) => e.occurrenceDate !== target)) {
            expect(other.data?.attendees?.[0]?.status).toBe('pending');
        }

        // Bob answered one occurrence of a series whose other instances never moved.
        for (const other of (await bobOccurrences(series.uid)).filter((e) => e.occurrenceDate !== target)) {
            expect(other.title).toBe('Weekly Occurrence RSVP');
        }
    });

    test('an RSVP to one occurrence refuses a recurrenceDate that names no occurrence', async () => {
        const { series } = await seeded('Weekly Occurrence Bad Key');
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${bobMaster.id}/rsvp`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted', scope: 'this', recurrenceDate: 'garbage' }),
            },
        );
        expect(res.status).toBe(400);
    });

    // An override that names nobody is a client that did not restate the guest list — a stored VEVENT
    // cannot tell that apart from "this occurrence has no guests" — so an override moves the occurrence
    // and never changes who is invited to it.
    test('an override naming no guests still reaches the series guests', async () => {
        const { series, target } = await seeded('Weekly Occurrence Guestless');

        await editOccurrence(series.id, target, { title: 'Still Bob', data: { attendees: [] } });

        const occurrences = await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Still Bob'));
        expect(occurrences).toHaveLength(4);
        expect(findOrFail(occurrences, (e) => e.occurrenceDate === target).title).toBe('Still Bob');
    });

    // An external guest has no relay, so the series reaches them as one VCALENDAR holding the master, its EXDATEs and its overrides (RFC 5546).
    test('an external guest gets the series with its overrides and EXDATEs, on invite and on update', async () => {
        const CAROL = 'carol.series@example.org';
        const series = await createSeries('Weekly Occurrence External');
        const [, moved, deleted] = (await untilBob(series.uid, (occ) => occ.length === 4)).map((e) => e.occurrenceDate);
        const movedStart = new Date(Date.parse(`${moved}T09:00:00Z`) + HOUR);
        await editOccurrence(series.id, moved, {
            title: 'Moved For Carol',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await editOccurrence(series.id, deleted, { title: 'Weekly Occurrence External', status: 'cancelled' });
        await untilBob(series.uid, (occ) => occ.length === 3 && occ.some((e) => e.title === 'Moved For Carol'));

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();
        const mailTo = (subject: string) =>
            eventually(
                async () =>
                    spy.mock.calls
                        .map((call) => call[0])
                        .find((m) => m.subject.startsWith(subject) && m.to.some((t) => t.address === CAROL)),
                `the ${subject} to reach Carol`,
            );
        const put = (body: Record<string, unknown>) =>
            authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
                { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            );
        const attendees = [...guests(), { email: CAROL, name: 'Carol', status: 'pending', role: 'required' }];

        expect((await put({ data: { attendees } })).status).toBe(200);
        const invite = await mailTo('Invitation');
        expect((await put({ title: 'Weekly External Renamed', data: { attendees } })).status).toBe(200);
        const update = await mailTo('Updated invitation');
        spy.mockRestore();

        const compact = (key: string) => `${key.replaceAll('-', '')}T100000`;
        for (const mail of [invite, update]) {
            const ics = mail.icalEvent!.content.replace(/\r\n[ \t]/g, '');
            const lines = ics.split('\r\n');
            const count = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).length;
            expect(count(/^BEGIN:VCALENDAR$/)).toBe(1);
            expect(count(/^METHOD:/)).toBe(1);
            expect(count(/^BEGIN:VEVENT$/)).toBe(2);
            expect(ics).toContain(`EXDATE;TZID=${TZ}:${compact(deleted)}`);
            expect(ics).toContain(`RECURRENCE-ID;TZID=${TZ}:${compact(moved)}`);
            expect(ics).not.toContain(`RECURRENCE-ID;TZID=${TZ}:${compact(deleted)}`);
            expect(ics).toContain('SUMMARY:Moved For Carol');
            // Every VEVENT names the organizer and rides them along as an accepted attendee.
            expect(count(/^ORGANIZER/)).toBe(2);
            expect(count(new RegExp(`^ATTENDEE.*:mailto:${ctx.alice.user.email}$`))).toBe(2);
            expect(ics).not.toContain('X-EIGEN');
            expect(ics).not.toContain('BEGIN:VALARM');
        }
    });

    test('the guest is told an invitation changed, not that they were invited to a new series', async () => {
        const { series, target } = await seeded('Weekly Occurrence Notice');
        const bobHome = await getHome(ctx.bob.user.id);
        const persist = spyOn(bobHome.notifications!, 'persist');
        persist.mockClear();

        await editOccurrence(series.id, target, { title: 'Notice Moved' });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Notice Moved'));

        const calls = persist.mock.calls.map((call) => call[0]).filter((n) => n.type.startsWith('calendar-invite'));
        persist.mockRestore();
        expect(calls).not.toHaveLength(0);
        expect(calls.every((n) => n.type === 'calendar-invite-updated')).toBe(true);
    });
});
