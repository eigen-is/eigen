// CalDAV iCalendar round-trip fidelity (audit deep-dive findings #C, #D, #F, #G + controls).
//
// Drives client-faithful payloads (Apple/Thunderbird emission shapes) through the real CalDAV
// PUT/GET handlers and diffs what round-trips — against the app-facing occurrence expansion
// (event-range) and against a re-parse of the served .ics. Sibling nets: occurrence keying (#8)
// in calendar-timezone.test.ts, iMIP instance scoping (#A/#B/#H) in ical-imip.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import ICAL from 'ical.js';
import { parseIcs } from '../../lib/caldav/ical-parse';
import { serializeEventForImip } from '../../lib/caldav/ical-serialize';
import { getHome } from '../../lib/home';
import { app, assertJson, authedRequest, getTestContext } from '../setup';

const VTZ_NY = [
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'DTSTART:20070311T020000',
    'TZNAME:EDT',
    'TZOFFSETTO:-0400',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'DTSTART:20071104T020000',
    'TZNAME:EST',
    'TZOFFSETTO:-0500',
    'END:STANDARD',
    'END:VTIMEZONE',
].join('\r\n');

const VTZ_AMS = [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'DTSTART:19810329T020000',
    'TZNAME:CEST',
    'TZOFFSETTO:+0200',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'DTSTART:19961027T030000',
    'TZNAME:CET',
    'TZOFFSETTO:+0100',
    'END:STANDARD',
    'END:VTIMEZONE',
].join('\r\n');

function vcal(...blocks: string[]): string {
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Apple Inc.//macOS 14.5//EN',
        'CALSCALE:GREGORIAN',
        ...blocks,
        'END:VCALENDAR',
    ].join('\r\n');
}

function epoch(iso: string): number {
    return Math.floor(Date.parse(iso) / 1000);
}

describe('CalDAV round-trip fidelity', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    let calendarId: string;

    const basicAuth = (email: string, password = 'testpassword123') => `Basic ${btoa(`${email}:${password}`)}`;

    async function putIcs(uri: string, body: string): Promise<Response> {
        return app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar; charset=utf-8',
                },
                body,
            }),
        );
    }

    async function getIcs(uri: string): Promise<string> {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(200);
        return res.text();
    }

    async function getOccurrences(fromIso: string, toIso: string): Promise<CalendarEventOccurrence[]> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/event-range/${epoch(fromIso)}/${epoch(toIso)}`,
        );
        return assertJson<CalendarEventOccurrence[]>(res);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        const xml = await res.text();
        const matches = xml.matchAll(new RegExp(`/dav/calendars/${userId}/([^/<]+)/`, 'g'));
        const ids = [...matches].map((m) => m[1]).filter(Boolean);
        expect(ids.length).toBeGreaterThan(0);
        calendarId = ids[0];
    });

    describe('EXDATE forms', () => {
        // Same class as audit #8 — Exchange/Outlook and several CalDAV clients normalize EXDATE to
        // UTC (Z) form; the key must still be the series wall-clock date, not the UTC date.
        test('EXDATE in UTC (Z) form cancels the intended occurrence', async () => {
            const body = vcal(
                VTZ_NY,
                [
                    'BEGIN:VEVENT',
                    'UID:rt-exdate-utc@eigen',
                    'DTSTART;TZID=America/New_York:20260305T230000',
                    'DTEND;TZID=America/New_York:20260306T000000',
                    'RRULE:FREQ=WEEKLY',
                    'EXDATE:20260320T030000Z',
                    'SUMMARY:UTC exdate series',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-exdate-utc.ics', body);
            expect(put.status).toBe(201);

            const occs = (await getOccurrences('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).filter(
                (o) => o.uid === 'rt-exdate-utc@eigen',
            );
            const starts = occs.map((o) => new Date(o.startTime).toISOString());
            expect(starts).toContain('2026-03-06T04:00:00.000Z');
            expect(starts).not.toContain('2026-03-20T03:00:00.000Z');
        });

        test('control: DATE-form EXDATE cancels an all-day occurrence', async () => {
            const body = vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:rt-allday@eigen',
                    'DTSTART;VALUE=DATE:20260406',
                    'DTEND;VALUE=DATE:20260407',
                    'RRULE:FREQ=WEEKLY',
                    'EXDATE;VALUE=DATE:20260413',
                    'SUMMARY:All-day series',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-allday.ics', body);
            expect(put.status).toBe(201);

            const occs = (await getOccurrences('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z')).filter(
                (o) => o.uid === 'rt-allday@eigen',
            );
            const dates = occs.map((o) => o.occurrenceDate);
            expect(dates).toContain('2026-04-06');
            expect(dates).toContain('2026-04-20');
            expect(dates).not.toContain('2026-04-13');
        });
    });

    describe('round-trip fidelity (PUT → store → GET → re-parse)', () => {
        test('control: serializer regenerates the correct wall-clock time for a TZID event', async () => {
            const body = vcal(
                VTZ_NY,
                [
                    'BEGIN:VEVENT',
                    'UID:rt-instant@eigen',
                    'DTSTART;TZID=America/New_York:20260305T230000',
                    'DTEND;TZID=America/New_York:20260306T000000',
                    'SUMMARY:RT instant',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-instant.ics', body);
            expect(put.status).toBe(201);

            const ics = await getIcs('rt-instant.ics');
            expect(ics).toContain('DTSTART;TZID=America/New_York:20260305T230000');
        });

        // Audit #F: RFC 5545 §3.6.5 requires a VTIMEZONE per referenced TZID. Without one, strict
        // parsers (including ical.js) read the wall time as floating and the instant shifts.
        test('served TZID events carry a VTIMEZONE and survive our own GET → parse round-trip', async () => {
            const ics = await getIcs('rt-instant.ics');
            expect(ics).toContain('BEGIN:VTIMEZONE');
            expect(ics).toContain('TZID:America/New_York');

            const reparsed = parseIcs(ics).events.find((e) => e.uid === 'rt-instant@eigen');
            expect(reparsed).toBeDefined();
            // Stored instant: Mar 5 23:00 EST = 2026-03-06T04:00:00Z
            expect(reparsed!.startTime.toISOString()).toBe('2026-03-06T04:00:00.000Z');

            // The emitted VTIMEZONE must resolve the instant on its own — through ical.js proper,
            // without the parser's IANA-TZID fallback.
            const comp = new ICAL.Component(ICAL.parse(ics));
            const vtz = comp.getFirstSubcomponent('vtimezone');
            expect(vtz).toBeDefined();
            const vevent = comp
                .getAllSubcomponents('vevent')
                .find((v) => v.getFirstPropertyValue('uid') === 'rt-instant@eigen');
            const dtstart = vevent!.getFirstProperty('dtstart')!.getFirstValue() as ICAL.Time;
            expect(dtstart.zone.tzid).toBe('America/New_York');
            expect(dtstart.toJSDate().toISOString()).toBe('2026-03-06T04:00:00.000Z');
        });

        // Audit #C: RECURRENCE-ID must name the ORIGINAL occurrence, not the exception's moved
        // startTime — a moved rid matches no occurrence and clients render the original slot too.
        // (Timezone-independent: this fixture is pure UTC.)
        test('moved override round-trips RECURRENCE-ID as the original occurrence time', async () => {
            const body = vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:rt-rid@eigen',
                    'DTSTART:20260401T100000Z',
                    'DTEND:20260401T110000Z',
                    'RRULE:FREQ=WEEKLY',
                    'SUMMARY:UTC series',
                    'END:VEVENT',
                    'BEGIN:VEVENT',
                    'UID:rt-rid@eigen',
                    'RECURRENCE-ID:20260408T100000Z',
                    'DTSTART:20260408T140000Z',
                    'DTEND:20260408T150000Z',
                    'SUMMARY:UTC series (moved)',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-rid.ics', body);
            expect(put.status).toBe(201);

            const ics = await getIcs('rt-rid.ics');
            const comp = new ICAL.Component(ICAL.parse(ics));
            const override = comp
                .getAllSubcomponents('vevent')
                .find((v) => v.getFirstProperty('recurrence-id') != null);
            expect(override).toBeDefined();
            const rid = override!.getFirstProperty('recurrence-id')!.getFirstValue() as ICAL.Time;
            expect(rid.toJSDate().toISOString()).toBe('2026-04-08T10:00:00.000Z');
            // and the override's own DTSTART must stay at the moved time
            const dtstart = override!.getFirstProperty('dtstart')!.getFirstValue() as ICAL.Time;
            expect(dtstart.toJSDate().toISOString()).toBe('2026-04-08T14:00:00.000Z');
        });

        // Audit #C, TZID flavour: the rid must be in the MASTER's timezone form even though the
        // stored exception row may carry a different (or legacy null) timezone.
        test('moved override of a TZID series echoes the rid in the master timezone', async () => {
            const body = vcal(
                VTZ_NY,
                [
                    'BEGIN:VEVENT',
                    'UID:rt-rid-tz@eigen',
                    'DTSTART;TZID=America/New_York:20260305T230000',
                    'DTEND;TZID=America/New_York:20260305T235000',
                    'RRULE:FREQ=WEEKLY',
                    'SUMMARY:NY series',
                    'END:VEVENT',
                    'BEGIN:VEVENT',
                    'UID:rt-rid-tz@eigen',
                    'RECURRENCE-ID;TZID=America/New_York:20260312T230000',
                    'DTSTART;TZID=America/New_York:20260312T210000',
                    'DTEND;TZID=America/New_York:20260312T215000',
                    'SUMMARY:NY series (moved)',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-rid-tz.ics', body);
            expect(put.status).toBe(201);

            const ics = await getIcs('rt-rid-tz.ics');
            expect(ics).toContain('RECURRENCE-ID;TZID=America/New_York:20260312T230000');
        });

        // Audit #D: syncExceptionEvents must treat a PUT as a full-resource replace. Apple models
        // "undo delete occurrence" as a re-PUT without the EXDATE; the stale cancelled exception
        // row would otherwise keep the occurrence hidden forever.
        test('removing an EXDATE on re-PUT restores the occurrence (Apple undo)', async () => {
            const master = (exdate: boolean) =>
                vcal(
                    [
                        'BEGIN:VEVENT',
                        'UID:rt-undo@eigen',
                        'DTSTART:20260401T100000Z',
                        'DTEND:20260401T110000Z',
                        'RRULE:FREQ=WEEKLY',
                        ...(exdate ? ['EXDATE:20260415T100000Z'] : []),
                        'SUMMARY:Undo series',
                        'END:VEVENT',
                    ].join('\r\n'),
                );

            const put1 = await putIcs('rt-undo.ics', master(true));
            expect(put1.status).toBe(201);
            let occs = (await getOccurrences('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z')).filter(
                (o) => o.uid === 'rt-undo@eigen',
            );
            expect(occs.map((o) => new Date(o.startTime).toISOString())).not.toContain('2026-04-15T10:00:00.000Z');

            // The user hits undo — Apple re-PUTs the series without the EXDATE
            const put2 = await putIcs('rt-undo.ics', master(false));
            expect(put2.status).toBe(204);
            occs = (await getOccurrences('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z')).filter(
                (o) => o.uid === 'rt-undo@eigen',
            );
            expect(occs.map((o) => new Date(o.startTime).toISOString())).toContain('2026-04-15T10:00:00.000Z');
            // and the restore sticks on the next GET (no stale cancelled override re-taught)
            const ics = await getIcs('rt-undo.ics');
            expect(ics).not.toContain('STATUS:CANCELLED');
        });

        // The full-replace prune presumes the payload represents the whole resource. A degenerate
        // master-less PUT (no VEVENT without a RECURRENCE-ID) proves nothing about the exceptions
        // it omits, so it must not delete them.
        test('a master-less PUT does not prune stored exceptions', async () => {
            const withOverride = vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:rt-lone@eigen',
                    'DTSTART:20260501T100000Z',
                    'DTEND:20260501T110000Z',
                    'RRULE:FREQ=WEEKLY',
                    'EXDATE:20260515T100000Z',
                    'SUMMARY:Lone series',
                    'END:VEVENT',
                    'BEGIN:VEVENT',
                    'UID:rt-lone@eigen',
                    'RECURRENCE-ID:20260508T100000Z',
                    'DTSTART:20260508T140000Z',
                    'DTEND:20260508T150000Z',
                    'SUMMARY:Lone series (moved)',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            expect((await putIcs('rt-lone.ics', withOverride)).status).toBe(201);

            const loneOverride = vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:rt-lone@eigen',
                    'RECURRENCE-ID:20260508T100000Z',
                    'DTSTART:20260508T140000Z',
                    'DTEND:20260508T150000Z',
                    'SUMMARY:Lone series (moved again)',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            expect((await putIcs('rt-lone.ics', loneOverride)).status).toBe(204);

            const calendar = (await getHome(userId)).calendar;
            const masterRow = calendar.getEventByUri(calendarId, 'rt-lone.ics')!;
            // Both rows survive: the override (updated by the PUT) and the cancelled EXDATE row.
            expect(calendar.getExceptionsForParent(masterRow.id)).toHaveLength(2);
        });

        test('control: TEXT escaping and long-line folding survive the round-trip', async () => {
            const title = 'Board; agenda: budget, planning\nsecond line';
            const description = `Emoji 😀 and a very long line ${'x'.repeat(200)} with, commas; and\\ backslashes`;
            const escapeText = (s: string) =>
                s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
            const body = vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:rt-text@eigen',
                    'DTSTART:20260601T100000Z',
                    'DTEND:20260601T110000Z',
                    `SUMMARY:${escapeText(title)}`,
                    `DESCRIPTION:${escapeText(description)}`,
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-text.ics', body);
            expect(put.status).toBe(201);

            const ics = await getIcs('rt-text.ics');
            const reparsed = parseIcs(ics).events.find((e) => e.uid === 'rt-text@eigen');
            expect(reparsed).toBeDefined();
            expect(reparsed!.title).toBe(title);
            expect(reparsed!.description).toBe(description);
        });
    });

    // Rows written before the route validated recurrenceDate can hold a full ISO datetime or
    // arbitrary text (the schema accepted any string). App-side expansion truncates to the date
    // part and treats unparseable keys as inert (calendar.ts getEventsInRange); serving must do
    // the same — one bad row must never 500 the resource GET or every REPORT touching its UID.
    describe('legacy recurrenceDate rows', () => {
        test('an exception keyed by a full ISO datetime serves with the truncated-key RECURRENCE-ID', async () => {
            const calendar = (await getHome(userId)).calendar;
            const master = calendar.createEvent(calendarId, {
                title: 'Legacy key series',
                startTime: new Date('2026-06-02T03:00:00Z'), // Jun 1 23:00 America/New_York
                endTime: new Date('2026-06-02T03:50:00Z'),
                allDay: false,
                rrule: 'FREQ=DAILY;COUNT=5',
                timezone: 'America/New_York',
                uid: 'legacy-rid@eigen',
                uri: 'legacy-rid.ics',
                createByUserId: userId,
            });
            calendar.createEvent(calendarId, {
                title: 'Legacy key series (moved)',
                startTime: new Date('2026-06-05T10:00:00Z'),
                endTime: new Date('2026-06-05T10:50:00Z'),
                allDay: false,
                timezone: 'America/New_York',
                parentEventId: master.id,
                recurrenceDate: '2026-06-04T03:00:00.000Z', // legacy form: an instant, not a wall date
                uid: master.uid,
                createByUserId: userId,
            });

            const ics = await getIcs('legacy-rid.ics'); // pre-fix: 500 (RRule.between throws on the raw key)
            // The truncated key '2026-06-04' names the Jun 4 23:00 NY occurrence — the same
            // instance the app-side expansion substitutes for this row.
            expect(ics).toContain('RECURRENCE-ID;TZID=America/New_York:20260604T230000');
        });

        test('unparseable recurrenceDate keys are inert: the resource still serves', async () => {
            const calendar = (await getHome(userId)).calendar;
            const master = calendar.createEvent(calendarId, {
                title: 'Garbage key series',
                startTime: new Date('2026-06-02T03:00:00Z'),
                endTime: new Date('2026-06-02T03:50:00Z'),
                allDay: false,
                rrule: 'FREQ=DAILY;COUNT=5',
                timezone: 'America/New_York',
                uid: 'legacy-garbage@eigen',
                uri: 'legacy-garbage.ics',
                createByUserId: userId,
            });
            calendar.createEvent(calendarId, {
                title: 'Garbage key series',
                startTime: new Date('2026-06-03T03:00:00Z'),
                endTime: new Date('2026-06-03T03:50:00Z'),
                allDay: false,
                parentEventId: master.id,
                recurrenceDate: 'not-a-date',
                status: 'cancelled',
                uid: master.uid,
                createByUserId: userId,
            });
            calendar.createEvent(calendarId, {
                title: 'Garbage key series (moved)',
                startTime: new Date('2026-06-10T10:00:00Z'),
                endTime: new Date('2026-06-10T10:50:00Z'),
                allDay: false,
                timezone: 'America/New_York',
                parentEventId: master.id,
                recurrenceDate: 'also!garbage',
                uid: master.uid,
                createByUserId: userId,
            });

            const ics = await getIcs('legacy-garbage.ics'); // pre-fix: 500
            // The unkeyable cancellation cancels nothing (matches expansion) — no EXDATE emitted.
            expect(ics).not.toContain('EXDATE');
            // The unkeyable override falls back to its own startTime (pre-#C shape) rather than 500ing.
            expect(ics).toContain('RECURRENCE-ID;TZID=America/New_York:20260610T060000');
        });
    });

    describe('DST-boundary expansion for CalDAV-created events', () => {
        test('weekly 09:30 Europe/Amsterdam keeps its wall-clock time across the fall-back', async () => {
            const body = vcal(
                VTZ_AMS,
                [
                    'BEGIN:VEVENT',
                    'UID:rt-dst@eigen',
                    'DTSTART;TZID=Europe/Amsterdam:20261019T093000',
                    'DTEND;TZID=Europe/Amsterdam:20261019T103000',
                    'RRULE:FREQ=WEEKLY',
                    'SUMMARY:Morning standup',
                    'END:VEVENT',
                ].join('\r\n'),
            );
            const put = await putIcs('rt-dst.ics', body);
            expect(put.status).toBe(201);

            const occs = (await getOccurrences('2026-10-12T00:00:00Z', '2026-11-09T00:00:00Z')).filter(
                (o) => o.uid === 'rt-dst@eigen',
            );
            const starts = occs.map((o) => new Date(o.startTime).toISOString());
            expect(starts).toContain('2026-10-19T07:30:00.000Z'); // CEST (UTC+2)
            expect(starts).toContain('2026-10-26T08:30:00.000Z'); // CET (UTC+1), after Oct 25 fall-back
            expect(starts).toContain('2026-11-02T08:30:00.000Z');
        });
    });

    // Audit #F, iMIP leg: an Eigen→Eigen invitation of an event in a non-server timezone must not
    // shift the instant — the outbound ICS carries a VTIMEZONE the receiving parser can resolve.
    describe('iMIP federation round-trip', () => {
        test('serializeEventForImip emits a VTIMEZONE and the instant survives re-parsing', () => {
            const event: CalendarEvent = {
                id: 'imip-rt-1',
                calendarId: 'cal-1',
                uid: 'imip-rt@eigen',
                uri: 'imip-rt@eigen.ics',
                title: 'Federated invite',
                description: null,
                location: null,
                startTime: new Date('2026-03-06T04:00:00Z'), // Mar 5 23:00 America/New_York (EST)
                endTime: new Date('2026-03-06T05:00:00Z'),
                allDay: false,
                rrule: 'FREQ=WEEKLY',
                timezone: 'America/New_York',
                parentEventId: null,
                recurrenceDate: null,
                status: 'confirmed',
                sequence: 0,
                etag: 'x',
                data: { organizer: { userId: 'u1', email: 'alice@a.example' } },
                createByUserId: 'u1',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
            };
            const ics = serializeEventForImip(event, 'REQUEST');
            expect(ics).toContain('BEGIN:VTIMEZONE');
            expect(ics).toContain('TZID:America/New_York');
            expect(ics).toContain('DTSTART;TZID=America/New_York:20260305T230000');

            const reparsed = parseIcs(ics).events[0];
            expect(reparsed.startTime.toISOString()).toBe('2026-03-06T04:00:00.000Z');
            expect(reparsed.timezone).toBe('America/New_York');

            // ical.js proper (no IANA-TZID fallback) must resolve it through the emitted VTIMEZONE.
            const comp = new ICAL.Component(ICAL.parse(ics));
            const dtstart = comp
                .getFirstSubcomponent('vevent')!
                .getFirstProperty('dtstart')!
                .getFirstValue() as ICAL.Time;
            expect(dtstart.zone.tzid).toBe('America/New_York');
            expect(dtstart.toJSDate().toISOString()).toBe('2026-03-06T04:00:00.000Z');
        });
    });

    // Audit #G: floating and unresolvable-TZID datetimes must not be read through the server's
    // local timezone. bun test pins TZ=UTC, which masks the bug (floating-as-local == floating-as-
    // UTC there), so these tests pin a far-away server zone.
    describe('floating datetimes parse independent of the server timezone (audit #G)', () => {
        let originalTz: string | undefined;

        beforeAll(() => {
            originalTz = process.env.TZ;
            process.env.TZ = 'Asia/Tokyo';
        });

        afterAll(() => {
            if (originalTz === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = originalTz;
            }
        });

        const floatingVcal = (dtstart: string, extra: string[] = []) =>
            vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:g-float@eigen',
                    dtstart,
                    'DTEND:20260211T235000',
                    ...extra,
                    'SUMMARY:Floating',
                    'END:VEVENT',
                ].join('\r\n'),
            );

        test('a floating DTSTART maps its wall components to UTC', () => {
            const parsed = parseIcs(floatingVcal('DTSTART:20260211T230000')).events[0];
            expect(parsed.startTime.toISOString()).toBe('2026-02-11T23:00:00.000Z');
            expect(parsed.endTime.toISOString()).toBe('2026-02-11T23:50:00.000Z');
            expect(parsed.timezone).toBeNull();
        });

        test('a valid IANA TZID without a VTIMEZONE is interpreted in that zone (RFC 7809)', () => {
            const parsed = parseIcs(floatingVcal('DTSTART;TZID=America/New_York:20260305T230000')).events[0];
            // 23:00 EST = 04:00Z next day — consistent with the stored timezone column, which the
            // recurrence expansion already trusts.
            expect(parsed.startTime.toISOString()).toBe('2026-03-06T04:00:00.000Z');
            expect(parsed.timezone).toBe('America/New_York');
        });

        test('a non-IANA TZID degrades to the floating UTC mapping', () => {
            const parsed = parseIcs(floatingVcal('DTSTART;TZID=W. Europe Standard Time:20260211T230000')).events[0];
            expect(parsed.startTime.toISOString()).toBe('2026-02-11T23:00:00.000Z');
            expect(parsed.timezone).toBeNull();
        });

        test('floating EXDATE and RECURRENCE-ID key consistently with floating expansion', () => {
            const { events } = parseIcs(
                vcal(
                    [
                        'BEGIN:VEVENT',
                        'UID:g-float-keys@eigen',
                        'DTSTART:20260211T230000',
                        'DTEND:20260211T235000',
                        'RRULE:FREQ=DAILY;COUNT=5',
                        'EXDATE:20260213T230000',
                        'SUMMARY:Floating series',
                        'END:VEVENT',
                        'BEGIN:VEVENT',
                        'UID:g-float-keys@eigen',
                        'RECURRENCE-ID:20260212T230000',
                        'DTSTART:20260212T220000',
                        'DTEND:20260212T225000',
                        'SUMMARY:Floating series (moved)',
                        'END:VEVENT',
                    ].join('\r\n'),
                ),
            );
            const master = events.find((e) => e.rrule);
            const exdate = events.find((e) => e.status === 'cancelled');
            const override = events.find((e) => e.title === 'Floating series (moved)');
            // Keys are the raw wall dates; the master's startTime maps the same wall components to
            // UTC, so occurrenceDateToString(startTime) lands on the same dates during expansion.
            expect(master!.startTime.toISOString()).toBe('2026-02-11T23:00:00.000Z');
            expect(exdate!.recurrenceDate).toBe('2026-02-13');
            expect(override!.recurrenceDate).toBe('2026-02-12');
            expect(override!.startTime.toISOString()).toBe('2026-02-12T22:00:00.000Z');
        });
    });
});
