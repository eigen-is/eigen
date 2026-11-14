// One occurrence of an invited series, over the Home relay: the organizer's "this event" edit must reach
// the guest as an exception on their linked series — never as an update of the whole series — and the
// same for a second edit, a cancellation and a guest's RSVP. Every date stores its whole guest list, follows the
// series' guest changes and each guest's answer for the whole series, and a recolour tells no guest. Driven through
// the routes the calendar app calls (docs/CALENDAR.md § An occurrence message names the series).
import { beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem, EventData } from '@workspace/lib/types/calendar';
import { processInboundImip } from '../../lib/calendar/imip';
import { getHome } from '../../lib/home';
import { parseIcs } from '../../lib/ical';
import { utcStampString } from '../../lib/ical/ical-parse';
import { davRequest } from '../dav-test-helpers';
import { vcal } from '../ics-test-helpers';
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

    const guests = () => [
        { email: ctx.bob.user.email, name: 'Bob', status: 'pending' as const, role: 'required' as const },
    ];

    async function createSeries(title: string, attendees: object[] = guests()): Promise<CalendarEvent> {
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
                    data: { attendees },
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

    // A stored resource, read the way the owner's CalDAV client reads it.
    async function storedIcs(user: { id: string; email: string }, calendarId: string, uid: string): Promise<string> {
        const home = await getHome(user.id);
        const resource = findOrFail(await home.calendar.listResources(calendarId), (r) => r.uid === uid);
        const res = await davRequest('GET', `/dav/calendars/${user.id}/${calendarId}/${resource.uri}`, {
            email: user.email,
        });
        expect(res.status).toBe(200);
        return res.text();
    }
    const bobIcs = (uid: string) => storedIcs(ctx.bob.user, bobCalendarId, uid);
    // Each VEVENT of Alice's stored resource, its folded lines joined.
    const aliceVEvents = async (uid: string) =>
        (await storedIcs(ctx.alice.user, aliceCalendarId, uid))
            .replace(/\r\n[ \t]/g, '')
            .split('BEGIN:VEVENT')
            .slice(1);

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

    const putEvent = (id: string, body: Record<string, unknown>) =>
        authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${id}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );

    // Bob plus an external guest, who has no relay and hears of every change by mail.
    async function seededWithExternal(title: string, external: string) {
        const attendees = [
            ...guests(),
            { email: external, name: 'Carol', status: 'pending' as const, role: 'required' },
        ];
        const series = await createSeries(title);
        expect((await putEvent(series.id, { data: { attendees } })).status).toBe(200);
        const target = (await untilBob(series.uid, (occ) => occ.length === 4))[1].occurrenceDate;
        return { series, target, attendees };
    }

    // `target` moved an hour later under `title`, once Bob's copy has it.
    async function moveOccurrence(series: CalendarEvent, target: string, title: string, data?: object) {
        const movedStart = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);
        const override = await editOccurrence(series.id, target, {
            title,
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
            ...(data && { data }),
        });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === title));
        return override;
    }

    // Holds what Eigen mails; `to` waits for the mail to `address` whose subject starts with `subject`.
    async function catchMail() {
        const mailer = await import('../../lib/mailer/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();
        return {
            to: (address: string, subject: string) =>
                eventually(
                    async () =>
                        spy.mock.calls
                            .map((call) => call[0])
                            .find((m) => m.subject.startsWith(subject) && m.to.some((t) => t.address === address)),
                    `the ${subject} to reach ${address}`,
                ),
            sent: (address: string) =>
                spy.mock.calls.map((call) => call[0]).filter((m) => m.to.some((t) => t.address === address)),
            restore: () => spy.mockRestore(),
        };
    }

    const unfolded = (mail: { icalEvent?: { content: string } }) => mail.icalEvent!.content.replace(/\r\n[ \t]/g, '');

    // The CANCEL that `act` mails to `address`.
    async function cancelMailTo(address: string, act: () => Promise<Response>) {
        const mail = await catchMail();
        try {
            expect((await act()).status).toBe(200);
            const cancel = await mail.to(address, 'Canceled');
            return { text: cancel.text, ics: unfolded(cancel) };
        } finally {
            mail.restore();
        }
    }

    // An outside guest's client answering by mail: the whole series, or the one date `date` names.
    async function mailedReply(series: CalendarEvent, from: string, partstat: string, date?: string) {
        const day = (date ?? SERIES_START.slice(0, 10)).replaceAll('-', '');
        const ics = vcal([
            'METHOD:REPLY',
            'BEGIN:VEVENT',
            `UID:${series.uid}`,
            ...(date ? [`RECURRENCE-ID;TZID=${TZ}:${day}T100000`] : []),
            `DTSTART;TZID=${TZ}:${day}T100000`,
            `DTEND;TZID=${TZ}:${day}T110000`,
            'DTSTAMP:20270101T000000Z',
            `ORGANIZER:mailto:${ctx.alice.user.email}`,
            `ATTENDEE;PARTSTAT=${partstat}:mailto:${from}`,
            'END:VEVENT',
        ]);
        const content = Buffer.from(ics);
        const attachment = { contentType: 'text/calendar', content, index: 0, size: content.length };
        await processInboundImip(
            await getHome(ctx.alice.user.id),
            {
                attachments: [{ ...attachment, calendarMethod: 'REPLY' }],
                from: { value: [{ address: from, name: '' }], text: '' },
            },
            { verified: true, reason: 'a verified test sender' },
        );
    }

    const statusOf = (event: { data?: EventData | null } | undefined, email: string) =>
        event?.data?.attendees?.find((a) => a.email === email)?.status;

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

    // The web app's "Delete this" on a moved occurrence: the organizer stores an EXDATE in its place, and the guest
    // drops it too. The mail names the slot the guest last saw, the RECURRENCE-ID the original one.
    test('cancelling a moved occurrence drops it for the guest and mails its moved time', async () => {
        const CAROL = 'carol.cancel-moved@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Occurrence Cancel Moved', CAROL);
        const override = await moveOccurrence(series, target, 'Moved Then Cancelled', { attendees });

        const { text, ics } = await cancelMailTo(CAROL, () => putEvent(override.id, { status: 'cancelled' }));
        const day = target.replaceAll('-', '');
        expect(ics).toContain(`RECURRENCE-ID;TZID=${TZ}:${day}T100000`);
        expect(ics).toContain(`DTSTART;TZID=${TZ}:${day}T110000`);
        expect(ics).toContain(`DTEND;TZID=${TZ}:${day}T120000`);
        expect(text).toContain('11:00');

        const occurrences = await untilBob(series.uid, (occ) => occ.length === 3);
        expect(occurrences.some((e) => e.occurrenceDate === target)).toBe(false);
        expect(await bobIcs(series.uid)).not.toContain('RECURRENCE-ID');
    });

    // A DELETE of the override row is the API's "delete this": the cancellation names the series plus the
    // ORIGINAL occurrence, which is what the guest's copy holds, not the override's own id or moved start.
    test('deleting a moved occurrence over REST cancels it for every guest', async () => {
        const CAROL = 'carol.delete@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Occurrence Delete', CAROL);
        const override = await moveOccurrence(series, target, 'Moved Then Deleted', { attendees });

        const { ics } = await cancelMailTo(CAROL, () =>
            authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${override.id}`,
                { method: 'DELETE' },
            ),
        );
        expect(ics).toContain(`RECURRENCE-ID;TZID=${TZ}:${target.replaceAll('-', '')}T100000`);
        expect(ics).toContain('STATUS:CANCELLED');

        const occurrences = await untilBob(series.uid, (occ) => occ.length === 3);
        expect(occurrences.some((e) => e.occurrenceDate === target)).toBe(false);
    });

    // Someone can be invited to one date only, so a series' guests are every date's as well as its own.
    test('deleting a series cancels it for the guests of one date only', async () => {
        const CAROL = 'carol.date-only@example.org';
        const series = await createSeries('Weekly Date Guests Delete', []);
        const date = '2027-02-09';
        const attendees = [...guests(), { email: CAROL, name: 'Carol', status: 'pending', role: 'required' }];
        await editOccurrence(series.id, date, { title: 'Date Guests Only', data: { attendees } });
        await untilBob(series.uid, (occ) => occ.length === 1);

        const { ics } = await cancelMailTo(CAROL, () =>
            authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
                { method: 'DELETE' },
            ),
        );
        expect(ics).toContain('STATUS:CANCELLED');
        await untilBob(series.uid, (occ) => occ.length === 0);
    });

    test('cancelling a series cancels it for the guests of one date only', async () => {
        const CAROL = 'carol.date-only-cancel@example.org';
        const series = await createSeries('Weekly Date Guests Cancel');
        const date = '2027-02-09';
        const attendees = [...guests(), { email: CAROL, name: 'Carol', status: 'pending', role: 'required' }];
        await editOccurrence(series.id, date, { title: 'Date Guests Cancel', data: { attendees } });
        await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Date Guests Cancel'));

        const { ics } = await cancelMailTo(CAROL, () => putEvent(series.id, { status: 'cancelled' }));
        expect(ics).toContain('STATUS:CANCELLED');
        expect(ics).not.toContain('RECURRENCE-ID');
        await untilBob(series.uid, (occ) => occ.length === 0);
    });

    test('deleting a cancelled series tells its guests nothing more', async () => {
        const CAROL = 'carol.cancelled-delete@example.org';
        const carol = { email: CAROL, name: 'Carol', status: 'pending' as const, role: 'required' as const };
        const series = await createSeries('Weekly Cancelled Then Deleted');
        await editOccurrence(series.id, '2027-02-09', {
            title: series.title,
            data: { attendees: [...guests(), carol] },
        });
        await cancelMailTo(CAROL, () => putEvent(series.id, { status: 'cancelled' }));
        await untilBob(series.uid, (occ) => occ.length === 0);

        const relay = await import('../../lib/home/home-relay');
        const relayed = spyOn(relay, 'sendToHome');
        const mail = await catchMail();
        try {
            relayed.mockClear();
            const deleted = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${series.id}`,
                { method: 'DELETE' },
            );
            expect(deleted.status).toBe(200);

            // Absence only counts behind what IS expected: a later invitation reaches both guests the path a CANCEL takes.
            await createSeries('Weekly After The Delete', [...guests(), carol]);
            await mail.to(CAROL, 'Invitation: Weekly After The Delete');
            await eventually(async () => relayed.mock.calls.length > 0 || undefined, 'the invitation to reach Bob');
            expect(mail.sent(CAROL)).toHaveLength(1);
            expect(relayed.mock.calls.map(([, message]) => message.type)).toEqual(['calendar:request']);
        } finally {
            mail.restore();
            relayed.mockRestore();
        }
    });

    // RFC 5546 § 2.1.4: each CANCEL raises the SEQUENCE. Eigen raises the series', which a guest who never got the date
    // on its own holds it at, so a CANCEL naming the date's older number could be dropped as stale.
    test("a cancelled date's CANCEL carries the series' SEQUENCE", async () => {
        const CAROL = 'carol.cancel-sequence@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Cancel Sequence', CAROL);
        await moveOccurrence(series, target, 'Cancel Sequence Moved', { attendees });
        for (const shift of [1, 2]) {
            const start = new Date(Date.parse(SERIES_START) + (shift * HOUR) / 4);
            expect(
                (await putEvent(series.id, { startTime: start, endTime: new Date(start.getTime() + HOUR) })).status,
            ).toBe(200);
        }
        const masterSequence = async () =>
            findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId).sequence;

        const unmoved = '2027-02-16';
        const cancelled = await cancelMailTo(CAROL, async () => {
            await editOccurrence(series.id, unmoved, { title: series.title, status: 'cancelled' });
            return new Response();
        });
        expect(cancelled.ics).toContain(`SEQUENCE:${await masterSequence()}\r\n`);

        const moved = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        const deleted = await cancelMailTo(CAROL, () =>
            authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${moved.id}`,
                { method: 'DELETE' },
            ),
        );
        expect(deleted.ics).toContain(`SEQUENCE:${await masterSequence()}\r\n`);
    });

    const sequenceIn = (ics: string) => Number(/\r\nSEQUENCE:(\d+)\r\n/.exec(ics)?.[1]);

    // Three series time edits raise the series' SEQUENCE past a date moved before them.
    async function bumpSeriesThrice(series: CalendarEvent) {
        for (const shift of [1, 2, 3]) {
            const start = new Date(Date.parse(SERIES_START) + (shift * HOUR) / 4);
            expect(
                (await putEvent(series.id, { startTime: start, endTime: new Date(start.getTime() + HOUR) })).status,
            ).toBe(200);
        }
        const master = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId);
        await untilBob(series.uid, (occ) => occ.some((e) => !e.parentEventId && e.sequence === master.sequence));
    }

    // A date's own SEQUENCE rises with each change to it, so neither the CANCEL that removes a guest nor the REQUEST
    // that adds them back reads as stale to that guest, whatever the series' number.
    for (const moved of [true, false]) {
        test(`a guest removed from ${moved ? 'a moved' : 'an unmoved'} date and added back gets it again`, async () => {
            const CAROL = `carol.readd-${moved}@example.org`;
            const charlie = { email: ctx.charlie.user.email, name: 'Charlie', status: 'pending', role: 'required' };
            const { series, target, attendees } = await seededWithExternal(`Weekly Readd ${moved}`, CAROL);
            const date = moved ? target : '2027-02-16';
            if (moved) await moveOccurrence(series, target, `Readd Moved ${moved}`, { attendees });
            await bumpSeriesThrice(series);

            const start = new Date(`${date}T12:00:00Z`);
            const times = { startTime: start, endTime: new Date(start.getTime() + HOUR) };
            const held = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === date).sequence;
            const cancel = await cancelMailTo(CAROL, async () => {
                if (!moved) {
                    await editOccurrence(series.id, date, {
                        title: 'Readd Charlie',
                        ...times,
                        data: { attendees: [charlie] },
                    });
                    return new Response();
                }
                const override = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === date);
                return putEvent(override.id, { data: { attendees: [charlie] } });
            });
            expect(sequenceIn(cancel.ics)).toBeGreaterThanOrEqual(held);
            await untilBob(series.uid, (occ) => occ.length === 3);

            const override = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === date);
            const mail = await catchMail();
            try {
                const readded = { data: { attendees: [charlie, ...attendees] } };
                expect((await putEvent(override.id, readded)).status).toBe(200);
                const request = unfolded(await mail.to(CAROL, 'Invitation'));
                expect(sequenceIn(request)).toBeGreaterThan(sequenceIn(cancel.ics));
            } finally {
                mail.restore();
            }
            const back = await untilBob(series.uid, (occ) => occ.length === 4);
            expect(back.map((e) => e.occurrenceDate)).toContain(date);
        });
    }

    const highestIn = (ics: string) => Math.max(...[...ics.matchAll(/\r\nSEQUENCE:(\d+)/g)].map((m) => Number(m[1])));
    // Every mail's highest SEQUENCE, in the order `address` got them.
    const sequencesTo = (mail: Awaited<ReturnType<typeof catchMail>>, address: string) =>
        mail.sent(address).map((sent) => highestIn(unfolded(sent)));

    // RFC 5546 § 2.1.4: each scheduling change takes the file's highest SEQUENCE plus one, so whatever a guest holds for
    // a date, the series' number or the date's own, the next change outranks it.
    test('a date moved three times, then the series, then the date again, outranks every revision before it', async () => {
        const CAROL = 'carol.high-water@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly High Water', CAROL);
        const held = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId).sequence;
        const mail = await catchMail();
        const sent: number[] = [];
        try {
            const at = (hours: number) => {
                const start = new Date(Date.parse(`${target}T09:00:00Z`) + hours * HOUR);
                return { startTime: start, endTime: new Date(start.getTime() + HOUR) };
            };
            const override = await editOccurrence(series.id, target, {
                title: 'High Water',
                ...at(1),
                data: { attendees },
            });
            for (const hours of [2, 3]) expect((await putEvent(override.id, at(hours))).status).toBe(200);
            const later = new Date(Date.parse(SERIES_START) + HOUR / 2);
            expect(
                (await putEvent(series.id, { startTime: later, endTime: new Date(later.getTime() + HOUR) })).status,
            ).toBe(200);
            expect((await putEvent(override.id, at(4))).status).toBe(200);
            await eventually(async () => {
                const seen = mail.sent(CAROL);
                return seen.length === 5 ? seen : undefined;
            }, 'all five updates to reach Carol');
            sent.push(...sequencesTo(mail, CAROL));
        } finally {
            mail.restore();
        }
        for (const [n, sequence] of sent.entries()) expect(sequence).toBeGreaterThan(n ? sent[n - 1] : held);
        const moved = new Date(Date.parse(`${target}T09:00:00Z`) + 4 * HOUR).getTime();
        await untilBob(series.uid, (occ) => occ.some((e) => new Date(e.startTime).getTime() === moved));
    });

    test("a date's CANCEL after another date's and a series edit outranks the series' last REQUEST", async () => {
        const CAROL = 'carol.cancel-after-series@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Cancel After Series', CAROL);
        const override = await moveOccurrence(series, target, 'Cancel After Series Moved', { attendees });
        await cancelMailTo(CAROL, async () => {
            await editOccurrence(series.id, '2027-02-16', { title: series.title, status: 'cancelled' });
            return new Response();
        });
        const mail = await catchMail();
        let request = '';
        try {
            const later = new Date(Date.parse(SERIES_START) + HOUR / 2);
            const moved = { startTime: later, endTime: new Date(later.getTime() + HOUR), data: { attendees } };
            expect((await putEvent(series.id, moved)).status).toBe(200);
            request = unfolded(await mail.to(CAROL, 'Updated invitation'));
        } finally {
            mail.restore();
        }

        const cancel = await cancelMailTo(CAROL, () => putEvent(override.id, { status: 'cancelled' }));
        expect(sequenceIn(cancel.ics)).toBeGreaterThan(highestIn(request));
        await untilBob(series.uid, (occ) => occ.length === 2);
    });

    // Bob's answer is recorded on Alice's date, which is no change of her schedule.
    test("a guest's answer for one date does not raise the organizer's SEQUENCE", async () => {
        const { series } = await seeded('Weekly Answer No Bump');
        const date = '2027-02-16';
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        const before = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId).sequence;
        expect(
            (await rsvpAsBob(bobMaster.id, { status: 'tentative', scope: 'this', recurrenceDate: date })).status,
        ).toBe(200);
        const answered = await eventually(async () => {
            const one = (await aliceOccurrences(series.uid)).find((e) => e.occurrenceDate === date);
            return one && statusOf(one, ctx.bob.user.email) === 'tentative' ? one : undefined;
        }, "Bob's answer to reach Alice");
        expect(answered.sequence).toBe(before);
        expect(findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId).sequence).toBe(before);
    });

    // A DELETE is a new revision of the date it removes, even when the date's own number is the file's highest.
    test("a moved date's DELETE mails a CANCEL that is no repeat of its last REQUEST", async () => {
        const CAROL = 'carol.delete-revision@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Delete Revision', CAROL);
        const override = await moveOccurrence(series, target, 'Delete Revision Moved', { attendees });
        const mail = await catchMail();
        let request = '';
        try {
            const start = new Date(Date.parse(`${target}T09:00:00Z`) + 2 * HOUR);
            const moved = { startTime: start, endTime: new Date(start.getTime() + HOUR) };
            expect((await putEvent(override.id, moved)).status).toBe(200);
            request = unfolded(await mail.to(CAROL, 'Updated invitation'));
        } finally {
            mail.restore();
        }
        const stampOf = (ics: string) => /\r\nDTSTAMP:(\S+)\r\n/.exec(ics)?.[1];
        setSystemTime(new Date(Date.now() + 5000));
        try {
            const cancel = await cancelMailTo(CAROL, () =>
                authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${override.id}`,
                    { method: 'DELETE' },
                ),
            );
            expect(sequenceIn(cancel.ics)).toBeGreaterThan(sequenceIn(request));
            expect(stampOf(cancel.ics)).not.toBe(stampOf(request));
        } finally {
            setSystemTime();
        }
    });

    test("a date moved past its series' SEQUENCE is cancelled at its own", async () => {
        const CAROL = 'carol.own-sequence@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Own Sequence', CAROL);
        const override = await moveOccurrence(series, target, 'Own Sequence Moved', { attendees });
        const mail = await catchMail();
        let seen = 0;
        try {
            for (const hours of [2, 3]) {
                const start = new Date(Date.parse(`${target}T09:00:00Z`) + hours * HOUR);
                const moved = { startTime: start, endTime: new Date(start.getTime() + HOUR) };
                expect((await putEvent(override.id, moved)).status).toBe(200);
            }
            const updates = await eventually(async () => {
                const sent = mail.sent(CAROL);
                return sent.length === 2 ? sent : undefined;
            }, 'both updates to reach Carol');
            seen = Math.max(...updates.map((sent) => sequenceIn(unfolded(sent))));
        } finally {
            mail.restore();
        }

        const cancel = await cancelMailTo(CAROL, () => putEvent(override.id, { status: 'cancelled' }));
        expect(sequenceIn(cancel.ics)).toBeGreaterThanOrEqual(seen);
        await untilBob(series.uid, (occ) => occ.length === 3);
    });

    // The row a cancelled date leaves on Bob's copy is the organizer's word, and deleting it gives Bob nothing back.
    test("a guest's DELETE of a date the organizer cancelled leaves it cancelled", async () => {
        const { series } = await seeded('Weekly Guest Deletes Cancelled');
        const date = '2027-02-16';
        await editOccurrence(series.id, date, { title: series.title, status: 'cancelled' });
        const held = await untilBob(series.uid, (occ) => occ.length === 3);
        const bobHome = await getHome(ctx.bob.user.id);
        const cancelled = findOrFail(
            await bobHome.calendar.getEventsByUid(series.uid),
            (e) => e.status === 'cancelled' && e.recurrenceDate === date,
        );
        const before = await bobIcs(series.uid);

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${cancelled.id}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
        expect(await bobOccurrences(series.uid)).toHaveLength(held.length);
        expect(await bobIcs(series.uid)).toBe(before);
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

        const res = await putEvent(series.id, { title: 'All Events', data: { attendees: guests() } });
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

    const organizerLine = () => new RegExp(`\\r\\nORGANIZER[^\\r]*:mailto:${ctx.alice.user.email}\\r\\n`);
    // The occurrence on `date` as the series has it, unmoved.
    const slotOf = (date: string) => ({
        startTime: new Date(`${date}T09:00:00Z`),
        endTime: new Date(`${date}T10:00:00Z`),
    });

    // RFC 5546 clients read a date's ATTENDEE lines as its whole guest list, so a CalDAV client syncing Alice's
    // calendar sees each date's guests and who organizes it: a date she moved, and one Bob answered on his own.
    test("every VEVENT of the organizer's series stores its whole guest list and the ORGANIZER", async () => {
        const CAROL = 'carol.stored-list@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Stored List', CAROL);
        await moveOccurrence(series, target, 'Stored List Moved', { attendees });
        const answered = '2027-02-16';
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        const oneDate = { status: 'tentative', scope: 'this', recurrenceDate: answered };
        expect((await rsvpAsBob(bobMaster.id, oneDate)).status).toBe(200);
        await eventually(async () => {
            const one = (await aliceOccurrences(series.uid)).find((e) => e.occurrenceDate === answered);
            return one?.parentEventId ? one : undefined;
        }, "Bob's answer for one date to reach Alice");

        const vevents = await aliceVEvents(series.uid);
        expect(vevents).toHaveLength(3);
        for (const vevent of vevents) {
            expect(vevent).toMatch(organizerLine());
            expect(vevent).toContain(`:mailto:${ctx.bob.user.email}\r\n`);
            expect(vevent).toContain(`:mailto:${CAROL}\r\n`);
        }
    });

    // RFC 5545 gives an event on one person's calendar no ORGANIZER, and a group-scheduled one must have it.
    test('an event takes the ORGANIZER line with its first guest', async () => {
        const series = await createSeries('Weekly First Guest', []);
        expect((await aliceVEvents(series.uid))[0]).not.toContain('ORGANIZER');

        expect((await putEvent(series.id, { data: { attendees: guests() } })).status).toBe(200);
        expect((await aliceVEvents(series.uid))[0]).toMatch(organizerLine());
    });

    test('an event drops the ORGANIZER line with its last guest', async () => {
        const series = await createSeries('Weekly Last Guest');
        expect((await aliceVEvents(series.uid))[0]).toMatch(organizerLine());

        expect((await putEvent(series.id, { data: { attendees: [] } })).status).toBe(200);
        expect((await aliceVEvents(series.uid))[0]).not.toContain('ORGANIZER');
    });

    test('a date the series gives its first guest names the ORGANIZER too', async () => {
        const series = await createSeries('Weekly Date First Guest', []);
        await editOccurrence(series.id, '2027-02-09', { title: 'Date First Guest Moved', data: { attendees: [] } });

        expect((await putEvent(series.id, { data: { attendees: guests() } })).status).toBe(200);
        const vevents = await aliceVEvents(series.uid);
        expect(vevents).toHaveLength(2);
        for (const vevent of vevents) expect(vevent).toMatch(organizerLine());
    });

    // An older build stored a date with guests and no ORGANIZER, and the rule holds across the whole file.
    test("an organizer's save gives an older date with guests the ORGANIZER it lacks", async () => {
        const uid = crypto.randomUUID();
        const GUEST = `older-dates-${uid}@example.org`;
        const { calendar } = await getHome(ctx.alice.user.id);
        const vevent = (lines: string[]) => [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            ...lines,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${GUEST}`,
            'END:VEVENT',
        ];
        const body = vcal([
            ...vevent(['DTSTART:20270202T090000Z', 'DTEND:20270202T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4']),
            ...vevent(['RECURRENCE-ID:20270209T090000Z', 'DTSTART:20270209T100000Z', 'DTEND:20270209T110000Z']),
        ]);
        const put = await calendar.putResource(aliceCalendarId, `${uid}.ics`, body, {
            ifMatch: null,
            ifNoneMatch: null,
        });
        expect(put.ok).toBe(true);
        const master = findOrFail(await calendar.getEventsByUid(uid), (e) => !e.recurrenceDate);

        // A color save carries no guest list, so it reaches no date of the series.
        expect((await putEvent(master.id, { data: { color: '#2563eb' } })).status).toBe(200);
        const vevents = await aliceVEvents(uid);
        expect(vevents).toHaveLength(2);
        for (const stored of vevents) expect(stored).toMatch(organizerLine());
        expect(vevents[1]).not.toContain('SEQUENCE:1');
    });

    // The ORGANIZER is the file's to keep. A body naming someone else would make the owner's own event an invitation
    // from that stranger.
    test("a save that names another organizer keeps the saver's ORGANIZER", async () => {
        const organizer = { email: 'mallory.organizer@example.org', name: 'Mallory' };
        const created = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Weekly Foreign Organizer',
                    startTime: SERIES_START,
                    endTime: SERIES_END,
                    allDay: false,
                    rrule: 'FREQ=WEEKLY;COUNT=4',
                    timezone: TZ,
                    data: { attendees: guests(), organizer },
                }),
            },
        );
        const series = await assertJson<CalendarEvent>(created);
        const renamed = { title: 'Foreign Organizer Renamed', data: { ...series.data, organizer } };
        expect((await putEvent(series.id, renamed)).status).toBe(200);
        await editOccurrence(series.id, '2027-02-09', {
            title: 'Foreign Organizer Date',
            data: { attendees: guests(), organizer },
        });

        const vevents = await aliceVEvents(series.uid);
        expect(vevents).toHaveLength(2);
        for (const stored of vevents) {
            expect(stored).toMatch(organizerLine());
            expect(stored).not.toContain(organizer.email);
        }
    });

    // A write with no user, such as a script's, on a personal calendar is the owner's.
    test("a write with no user names the calendar's owner as the ORGANIZER", async () => {
        const { calendar } = await getHome(ctx.alice.user.id);
        const event = await calendar.createEvent(aliceCalendarId, {
            title: 'Scripted Guests',
            startTime: new Date(SERIES_START),
            endTime: new Date(SERIES_END),
            allDay: false,
            data: { attendees: guests() },
        });
        expect((await aliceVEvents(event.uid))[0]).toMatch(organizerLine());
    });

    // A guest may re-alarm their copy and nothing more, one date included.
    test("a date Bob sets apart on his copy keeps the organizer's fields and takes only his reminders", async () => {
        const { series, target } = await seeded('Weekly Guest Date');
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        const reminders = [{ type: 'notification', minutes: 30 }];
        const moved = new Date(Date.parse(`${target}T09:00:00Z`) + HOUR);
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Renamed by Bob',
                    startTime: moved,
                    endTime: new Date(moved.getTime() + HOUR),
                    allDay: false,
                    timezone: TZ,
                    parentEventId: bobMaster.id,
                    recurrenceDate: target,
                    data: { reminders, attendees: [] },
                }),
            },
        );
        expect(res.status).toBe(200);

        const date = findOrFail((await bobStored(series.uid)).overrides, (e) => e.recurrenceDate === target);
        expect(date).toMatchObject({ title: series.title, ...slotOf(target), data: { reminders } });
        expect(date.data?.attendees?.map((a) => a.email)).toEqual([ctx.bob.user.email]);
    });

    // A date's list is its whole guest list, so an emptied one has no guests, and those it had hear it is cancelled.
    test("emptying one date's guest list cancels that date for its guests and leaves it guest-less", async () => {
        const CAROL = 'carol.emptied@example.org';
        const { series, target } = await seededWithExternal('Weekly Emptied Date', CAROL);

        const { ics } = await cancelMailTo(CAROL, async () => {
            await editOccurrence(series.id, target, {
                title: series.title,
                ...slotOf(target),
                data: { attendees: [] },
            });
            return new Response();
        });
        expect(ics).toContain(`RECURRENCE-ID;TZID=${TZ}:${target.replaceAll('-', '')}T100000`);

        const theirs = await untilBob(series.uid, (occ) => occ.length === 3);
        expect(theirs.map((e) => e.occurrenceDate)).not.toContain(target);
        const mine = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        expect(mine.data?.attendees ?? []).toEqual([]);
    });

    test('a guest the series gains joins a date whose list was emptied', async () => {
        const ERIN = 'erin.emptied@outside.test';
        const { series, target } = await seeded('Weekly Emptied Then Joined');
        await editOccurrence(series.id, target, { title: series.title, ...slotOf(target), data: { attendees: [] } });
        await untilBob(series.uid, (occ) => occ.length === 3);

        const erin = { email: ERIN, name: 'Erin', status: 'pending', role: 'required' };
        expect((await putEvent(series.id, { data: { attendees: [...guests(), erin] } })).status).toBe(200);

        const date = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        expect(date.data?.attendees?.map((a) => a.email)).toEqual([ERIN]);
    });

    // A colour is the organizer's own display choice: guests keep their own on their copy, so neither a date nor the
    // series recoloured is a message or a new revision.
    test('recolouring one date or the whole series tells no guest and raises no SEQUENCE', async () => {
        const CAROL = 'carol.recolour@example.org';
        const { series, attendees } = await seededWithExternal('Weekly Recolour', CAROL);
        const date = '2027-02-16';
        const held = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId).sequence;
        const relay = await import('../../lib/home/home-relay');
        const relayed = spyOn(relay, 'sendToHome');
        const mail = await catchMail();
        try {
            relayed.mockClear();
            const recoloured = { title: series.title, ...slotOf(date), data: { attendees, color: '#dc2626' } };
            await editOccurrence(series.id, date, recoloured);
            expect((await putEvent(series.id, { data: { color: '#16a34a' } })).status).toBe(200);

            const mine = await aliceOccurrences(series.uid);
            const recolouredDate = findOrFail(mine, (e) => e.occurrenceDate === date);
            expect(recolouredDate.parentEventId).toBe(series.id);
            expect(recolouredDate.data?.color).toBe('#dc2626');
            expect(recolouredDate.sequence).toBe(held);
            expect(findOrFail(mine, (e) => !e.parentEventId).sequence).toBe(held);

            // Absence only counts behind what IS expected: a rename, made last, takes the path the recolours must not.
            expect((await putEvent(series.id, { title: 'Weekly Recolour Renamed' })).status).toBe(200);
            await mail.to(CAROL, 'Updated invitation: Weekly Recolour Renamed');
            await untilBob(series.uid, (occ) => occ.some((e) => e.title === 'Weekly Recolour Renamed'));
            expect(mail.sent(CAROL)).toHaveLength(1);
            expect(relayed.mock.calls.filter(([, message]) => message.type === 'calendar:request')).toHaveLength(1);
        } finally {
            mail.restore();
            relayed.mockRestore();
        }
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

        const mail = await catchMail();
        const attendees = [...guests(), { email: CAROL, name: 'Carol', status: 'pending', role: 'required' }];

        expect((await putEvent(series.id, { data: { attendees } })).status).toBe(200);
        const invite = await mail.to(CAROL, 'Invitation');
        expect((await putEvent(series.id, { title: 'Weekly External Renamed', data: { attendees } })).status).toBe(200);
        const update = await mail.to(CAROL, 'Updated invitation');
        mail.restore();

        const compact = (key: string) => `${key.replaceAll('-', '')}T100000`;
        for (const sent of [invite, update]) {
            const ics = unfolded(sent);
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

    test('a guest added to a series reaches a date that holds its own list', async () => {
        const charlie = { email: ctx.charlie.user.email, name: 'Charlie', status: 'pending', role: 'required' };
        const series = await createSeries('Weekly Own List', [charlie]);
        const target = '2027-02-16';
        await editOccurrence(series.id, target, { title: 'Charlie Only', data: { attendees: [charlie] } });

        expect((await putEvent(series.id, { data: { attendees: [charlie, ...guests()] } })).status).toBe(200);

        const reached = await untilBob(series.uid, (occ) => occ.length === 4);
        expect(findOrFail(reached, (e) => e.occurrenceDate === target).title).toBe('Charlie Only');
        const own = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        expect(own.data?.attendees?.map((a) => a.email)).toEqual([charlie.email, ctx.bob.user.email]);
    });

    // A date's own list that takes a series guest change is a new revision of that date, for the organizer, in the mail
    // and on the guest's copy, where the date's own event in the same message still applies.
    test('a date whose own list follows a series guest change gets a new revision', async () => {
        const CAROL = 'carol.follow-revision@example.org';
        const ERIN = 'erin.follow-revision@outside.test';
        const { series, target, attendees } = await seededWithExternal('Weekly Follow Revision', CAROL);
        const before = await moveOccurrence(series, target, 'Follow Revision Moved', { attendees });

        const erin = { email: ERIN, name: 'Erin', status: 'pending', role: 'required' };
        const mail = await catchMail();
        // A revision's stamps have one-second resolution.
        setSystemTime(new Date(Date.now() + 5000));
        try {
            expect((await putEvent(series.id, { data: { attendees: [...attendees, erin] } })).status).toBe(200);
            const vevents = unfolded(await mail.to(CAROL, 'Updated invitation')).split('BEGIN:VEVENT');
            const date = findOrFail(vevents, (vevent) => vevent.includes('RECURRENCE-ID'));
            expect(date).toContain(`:mailto:${ERIN}\r\n`);
            expect(sequenceIn(date)).toBeGreaterThan(before.sequence);
            expect(date).not.toContain(`DTSTAMP:${utcStampString(new Date(before.updatedAt))}`);
        } finally {
            mail.restore();
            setSystemTime();
        }
        const after = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        expect(after.sequence).toBeGreaterThan(before.sequence);

        const { overrides } = await eventually(async () => {
            const stored = await bobStored(series.uid);
            return stored.overrides[0]?.sequence === after.sequence ? stored : undefined;
        }, "the date's new revision to reach Bob");
        expect(overrides[0].data?.attendees?.map((a) => a.email)).toContain(ERIN);
    });

    // Anna moves one date, Carol declines another by mail, and Anna adds Erin and later drops Carol: every date that
    // holds its own list takes the same change, and the mail Erin gets lists her on each of its VEVENTs.
    test("the series' guest changes reach every date that holds its own list, in each copy and each mail", async () => {
        const CAROL = 'carol.own-list@example.org';
        const ERIN = 'erin@outside.test';
        const { series, target, attendees } = await seededWithExternal('Weekly Own Lists', CAROL);
        await moveOccurrence(series, target, 'Own List Moved', { attendees });
        const declined = '2027-02-16';
        await mailedReply(series, CAROL, 'DECLINED', declined);

        const erin = { email: ERIN, name: 'Erin', status: 'pending', role: 'required' };
        const mail = await catchMail();
        // A revision's stamps have one-second resolution.
        setSystemTime(new Date(Date.now() + 5000));
        try {
            expect((await putEvent(series.id, { data: { attendees: [...attendees, erin] } })).status).toBe(200);
            const vevents = unfolded(await mail.to(ERIN, 'Invitation'))
                .split('BEGIN:VEVENT')
                .slice(1);
            expect(vevents).toHaveLength(3);
            for (const vevent of vevents) expect(vevent).toContain(`:mailto:${ERIN}\r\n`);
        } finally {
            mail.restore();
            setSystemTime();
        }

        const mine = await aliceOccurrences(series.uid);
        for (const date of [target, declined]) {
            const own = findOrFail(mine, (e) => e.occurrenceDate === date);
            expect(own.parentEventId).toBe(series.id);
            expect(statusOf(own, ERIN)).toBe('pending');
        }
        expect(
            statusOf(
                findOrFail(mine, (e) => e.occurrenceDate === declined),
                CAROL,
            ),
        ).toBe('declined');
        const { overrides } = await eventually(async () => {
            const stored = await bobStored(series.uid);
            return stored.overrides.length === 2 && stored.overrides.every((e) => statusOf(e, ERIN))
                ? stored
                : undefined;
        }, "Erin to reach the dates of Bob's copy");
        expect(
            statusOf(
                findOrFail(overrides, (e) => e.recurrenceDate === declined),
                CAROL,
            ),
        ).toBe('declined');

        const withoutCarol = [...guests(), erin];
        expect((await putEvent(series.id, { data: { attendees: withoutCarol } })).status).toBe(200);
        for (const own of (await aliceOccurrences(series.uid)).filter((e) => e.parentEventId)) {
            expect(own.data?.attendees?.map((a) => a.email)).toEqual([ctx.bob.user.email, ERIN]);
        }
    });

    test("a guest's answer for the series reaches every date, and an answer for one date only that date", async () => {
        const CAROL = 'carol.series-answer@example.org';
        const { series, target, attendees } = await seededWithExternal('Weekly Series Answer', CAROL);
        await moveOccurrence(series, target, 'Series Answer Moved', { attendees });
        const other = '2027-02-16';
        const carolOn = async (date: string) =>
            statusOf(
                (await aliceOccurrences(series.uid)).find((e) => e.occurrenceDate === date),
                CAROL,
            );

        await mailedReply(series, CAROL, 'ACCEPTED');
        expect(await carolOn(target)).toBe('accepted');
        await mailedReply(series, CAROL, 'DECLINED', other);
        expect([await carolOn(target), await carolOn(other)]).toEqual(['accepted', 'declined']);
        // The series' answer is already accepted, and the one date still takes it.
        await mailedReply(series, CAROL, 'ACCEPTED');
        expect(await carolOn(other)).toBe('accepted');

        // Bob answers in his own copy, which takes the same rule and tells Alice over the relay.
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        const oneDate = { status: 'tentative', scope: 'this', recurrenceDate: other };
        expect((await rsvpAsBob(bobMaster.id, oneDate)).status).toBe(200);
        await eventually(async () => {
            const one = (await aliceOccurrences(series.uid)).find((e) => e.occurrenceDate === other);
            return statusOf(one, ctx.bob.user.email) === 'tentative' ? one : undefined;
        }, "Bob's answer for one date to reach Alice");
        expect((await rsvpAsBob(bobMaster.id, { status: 'accepted' })).status).toBe(200);
        const bobs = await bobOccurrences(series.uid);
        expect([target, other].map((date) => bobStatus(findOrFail(bobs, (e) => e.occurrenceDate === date)))).toEqual([
            'accepted',
            'accepted',
        ]);
        await eventually(async () => {
            const mine = await aliceOccurrences(series.uid);
            return mine.every((e) => statusOf(e, ctx.bob.user.email) === 'accepted') ? mine : undefined;
        }, "Bob's answer to reach every date of Alice's series");
    });

    const bobStatus = (event: CalendarEventOccurrence) =>
        event.data?.attendees?.find((a) => a.email === ctx.bob.user.email)?.status;

    const rsvpAsBob = (eventId: string, body: Record<string, unknown>) =>
        authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${eventId}/rsvp`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );

    test("a guest who deleted their copy gets it back faded, with the series' moved and cancelled dates", async () => {
        const series = await createSeries('Weekly Deleted Copy');
        const [, moved, cancelled] = (await untilBob(series.uid, (occ) => occ.length === 4)).map(
            (e) => e.occurrenceDate,
        );
        const movedStart = new Date(Date.parse(`${moved}T09:00:00Z`) + HOUR);
        await editOccurrence(series.id, moved, {
            title: 'Deleted Copy Moved',
            startTime: movedStart,
            endTime: new Date(movedStart.getTime() + HOUR),
        });
        await editOccurrence(series.id, cancelled, { title: series.title, status: 'cancelled' });
        const held = await untilBob(
            series.uid,
            (occ) => occ.length === 3 && occ.some((e) => e.title === 'Deleted Copy Moved'),
        );
        const bobMaster = findOrFail(held, (e) => !e.parentEventId);
        expect((await rsvpAsBob(bobMaster.id, { status: 'declined', remove: true })).status).toBe(200);
        await eventually(async () => {
            const master = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId);
            return bobStatus(master) === 'declined' ? master : undefined;
        }, "Bob's decline to reach Alice");

        expect((await putEvent(series.id, { title: 'Weekly Deleted Copy Renamed' })).status).toBe(200);

        const back = await untilBob(series.uid, (occ) => occ.length === 3);
        expect(back.map((e) => e.title).sort()).toEqual([
            'Deleted Copy Moved',
            'Weekly Deleted Copy Renamed',
            'Weekly Deleted Copy Renamed',
        ]);
        expect(back.map((e) => e.occurrenceDate)).not.toContain(cancelled);
        expect(back.map(bobStatus)).toEqual(['declined', 'declined', 'declined']);
    });

    test('a date the guest removed comes back faded as declined on the next update', async () => {
        const series = await createSeries('Weekly Removed Date');
        const reached = await untilBob(series.uid, (occ) => occ.length === 4);
        const target = reached[1].occurrenceDate;
        const bobMaster = findOrFail(reached, (e) => !e.parentEventId);
        expect((await rsvpAsBob(bobMaster.id, { status: 'accepted' })).status).toBe(200);
        const removal = { status: 'declined', scope: 'this', recurrenceDate: target, remove: true };
        expect((await rsvpAsBob(bobMaster.id, removal)).status).toBe(200);
        await eventually(async () => {
            const one = (await aliceOccurrences(series.uid)).find((e) => e.occurrenceDate === target);
            return one && bobStatus(one) === 'declined' ? one : undefined;
        }, "Bob's removal to reach Alice as a decline");

        expect((await putEvent(series.id, { title: 'Weekly Removed Date Renamed' })).status).toBe(200);

        const back = await untilBob(series.uid, (occ) => occ.length === 4);
        expect(bobStatus(findOrFail(back, (e) => e.occurrenceDate === target))).toBe('declined');
        for (const other of back.filter((e) => e.occurrenceDate !== target)) expect(bobStatus(other)).toBe('accepted');
    });

    // The cut tells the organizer "declined" for the series, and a rescheduling brings that list back to Bob, but the
    // dates Bob kept keep the answer he gave them.
    test("a guest's cut keeps their answer on the dates they kept through a rescheduling", async () => {
        const { series, target } = await seeded('Weekly Cut Answer');
        await moveOccurrence(series, target, 'Cut Answer Moved');
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        expect((await rsvpAsBob(bobMaster.id, { status: 'accepted' })).status).toBe(200);
        const cut = { status: 'declined', scope: 'this-and-following', recurrenceDate: '2027-02-16', remove: true };
        expect((await rsvpAsBob(bobMaster.id, cut)).status).toBe(200);
        await eventually(async () => {
            const mine = await aliceOccurrences(series.uid);
            return mine.every((e) => bobStatus(e) === 'declined') ? mine : undefined;
        }, "Bob's cut to reach Alice as a decline");

        const later = new Date(Date.parse(SERIES_START) + HOUR / 2);
        expect(
            (await putEvent(series.id, { startTime: later, endTime: new Date(later.getTime() + HOUR) })).status,
        ).toBe(200);

        const kept = await untilBob(series.uid, (occ) => occ.some((e) => !e.parentEventId && e.sequence > 0));
        expect(kept.map((e) => [e.occurrenceDate, bobStatus(e)])).toEqual([
            ['2027-02-02', 'accepted'],
            [target, 'accepted'],
        ]);
    });

    test("a date the organizer moves after a guest's cut keeps the guest's answer", async () => {
        const { series, target } = await seeded('Weekly Cut Then Move');
        const bobMaster = findOrFail(await bobOccurrences(series.uid), (e) => !e.parentEventId);
        expect((await rsvpAsBob(bobMaster.id, { status: 'accepted' })).status).toBe(200);
        const cut = { status: 'declined', scope: 'this-and-following', recurrenceDate: '2027-02-16', remove: true };
        expect((await rsvpAsBob(bobMaster.id, cut)).status).toBe(200);
        await eventually(async () => {
            const master = findOrFail(await aliceOccurrences(series.uid), (e) => !e.parentEventId);
            return bobStatus(master) === 'declined' ? master : undefined;
        }, "Bob's cut to reach Alice as a decline");

        // The web app's "This event" sends the date's list as Alice sees it, which holds Bob's decline.
        const { data } = findOrFail(await aliceOccurrences(series.uid), (e) => e.occurrenceDate === target);
        await moveOccurrence(series, target, 'Moved After The Cut', { attendees: data?.attendees });

        const moved = findOrFail(await bobOccurrences(series.uid), (e) => e.occurrenceDate === target);
        expect(bobStatus(moved)).toBe('accepted');
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
