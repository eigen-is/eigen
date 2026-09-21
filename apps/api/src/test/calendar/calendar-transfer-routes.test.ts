import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ICS_MAX_BYTES } from '@workspace/lib/constants/calendar';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { type DrivePath, EML_MIME, ICS_MIME } from '@workspace/lib/types/drive';
import { SSEventType } from '@workspace/lib/types/sse';
import type { ImportCountsResult } from '@workspace/lib/types/transfer';
import { eq } from 'drizzle-orm';
import { user as userSchema } from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { getMailDomain } from '../../lib/config/server-config';
import { ICS_IMPORT_MAX_EVENTS } from '../../lib/core/transfer';
import { getHome } from '../../lib/home';
import { vcal } from '../ics-test-helpers';
import {
    app,
    assertJson,
    authedRequest,
    collectSSE,
    createTestUser,
    driveGet,
    drivePost,
    driveUpload,
    findOrFail,
    firstMountId,
    getTestContext,
    type TestUser,
} from '../setup';
import { importFromDriveRequest, importRaw } from '../transfer-test-helpers';

const PASSWORD = 'testpassword123';

const vevent = (uid: string, summary: string, start: string, end: string, extra: string[] = []) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    ...extra,
    'END:VEVENT',
];

// Own users, never the shared ctx home: the counts below are exact and other calendar suites write into alice.
describe('Calendar transfer routes', () => {
    let alice: TestUser;
    let bob: TestUser;
    let calendarId: string;
    let secondCalendarId: string;
    let bobCalendarId: string;
    let mountId: string;
    let rootId: string;
    let guestToken: string;
    let guestId: string;

    const importRequest = (user: TestUser, target: string, body: BodyInit, headers: Record<string, string> = {}) =>
        importRaw(user, 'calendar', ICS_MIME, body, { query: `?calendarId=${encodeURIComponent(target)}`, headers });

    const importFromDrive = (user: TestUser, target: string, source: DrivePath) =>
        importFromDriveRequest(user, 'calendar', source, { calendarId: target });

    const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

    const eventsInRange = async (user: TestUser, from: string, to: string): Promise<CalendarEventOccurrence[]> => {
        const res = await authedRequest(
            user.sessionToken,
            `/calendar/${user.id}/event-range/${epoch(from)}/${epoch(to)}`,
        );
        return assertJson<CalendarEventOccurrence[]>(res);
    };

    const april = (user: TestUser = alice) => eventsInRange(user, '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z');

    // One calendar's occurrences, so an imported series and a CalDAV-PUT one can be compared side by side.
    const calendarRange = async (calId: string, from: string, to: string): Promise<CalendarEventOccurrence[]> => {
        const res = await authedRequest(
            alice.sessionToken,
            `/calendar/${alice.id}/calendars/${calId}/event-range/${epoch(from)}/${epoch(to)}`,
        );
        return assertJson<CalendarEventOccurrence[]>(res);
    };

    const defaultCalendarOf = async (user: TestUser): Promise<CalendarItem> => {
        const res = await authedRequest(user.sessionToken, `/calendar/${user.id}/calendars`);
        return findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault);
    };

    const uploadIcs = async (text: string, name = 'calendar.ics'): Promise<DrivePath> => {
        const file = new File([new TextEncoder().encode(text)], name, { type: ICS_MIME });
        return driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);
    };

    beforeAll(async () => {
        await getTestContext();
        alice = await createTestUser('ics-import-alice@test.eigen.is', PASSWORD, 'Ics Import Alice');
        bob = await createTestUser('ics-import-bob@test.eigen.is', PASSWORD, 'Ics Import Bob');

        calendarId = (await defaultCalendarOf(alice)).id;
        bobCalendarId = (await defaultCalendarOf(bob)).id;

        const created = await authedRequest(alice.sessionToken, `/calendar/${alice.id}/calendars`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Imported', color: '#ff0000' }),
        });
        secondCalendarId = (await assertJson<CalendarItem>(created)).id;

        mountId = await firstMountId(alice.sessionToken, alice.id);
        rootId = (await driveGet(alice.sessionToken, alice.id, mountId, 'root')).id;

        const email = `ics-import-guest-${randomUUID()}@external.com`;
        const password = randomUUID();
        const guest = await auth.api.createUser({ body: { email, password, name: 'Import Guest', role: 'user' } });
        // Set to 'guest' directly — the admin plugin only allows 'user'/'admin' via the API.
        getAuthDrizzleDb().update(userSchema).set({ role: 'guest' }).where(eq(userSchema.id, guest.user.id)).run();
        const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password } });
        guestToken = (signIn.headers.get('set-cookie') ?? '').match(/better-auth\.session_token=([^;]+)/)?.[1] ?? '';
        guestId = guest.user.id;
    });

    test('a file of events lands in the calendar, and each one is the importing user to edit and delete', async () => {
        const stamp = randomUUID();
        const file = vcal(
            vevent(`plain-1-${stamp}@other`, 'Kickoff', '20260402T090000Z', '20260402T100000Z'),
            vevent(`plain-2-${stamp}@other`, 'Retro', '20260403T090000Z', '20260403T100000Z'),
            vevent(`plain-3-${stamp}@other`, 'Demo', '20260404T090000Z', '20260404T100000Z'),
        );

        const result = await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file));
        expect(result).toEqual({ imported: 3, skipped: 0, failed: 0 });

        const listed = await april();
        expect(
            listed
                .filter((e) => e.uid.includes(stamp))
                .map((e) => e.title)
                .sort(),
        ).toEqual(['Demo', 'Kickoff', 'Retro']);

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();

        const kickoff = findOrFail(listed, (e) => e.uid === `plain-1-${stamp}@other`);
        const edit = await authedRequest(
            alice.sessionToken,
            `/calendar/${alice.id}/calendars/${calendarId}/events/${kickoff.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Kickoff (moved)' }),
            },
        );
        expect((await assertJson<CalendarEvent>(edit)).title).toBe('Kickoff (moved)');

        const retro = findOrFail(listed, (e) => e.uid === `plain-2-${stamp}@other`);
        const removed = await authedRequest(
            alice.sessionToken,
            `/calendar/${alice.id}/calendars/${calendarId}/events/${retro.id}`,
            { method: 'DELETE' },
        );
        expect(removed.status).toBe(200);
        await new Promise((r) => setTimeout(r, 50));
        expect(spy.mock.calls.length).toBe(0);
        spy.mockRestore();

        expect((await april()).some((e) => e.uid === `plain-2-${stamp}@other`)).toBe(false);
    });

    test('re-importing the same file skips every event', async () => {
        const stamp = randomUUID();
        const file = vcal(
            vevent(`twice-1-${stamp}@other`, 'Once', '20260405T090000Z', '20260405T100000Z'),
            vevent(`twice-2-${stamp}@other`, 'Again', '20260405T110000Z', '20260405T120000Z'),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 2,
            skipped: 0,
            failed: 0,
        });
        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 0,
            skipped: 2,
            failed: 0,
        });
        expect((await april()).filter((e) => e.uid.includes(stamp)).length).toBe(2);
    });

    test('a UID already in another calendar of the home is skipped', async () => {
        const stamp = randomUUID();
        const file = vcal(vevent(`elsewhere-${stamp}@other`, 'Only once', '20260406T090000Z', '20260406T100000Z'));

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 0,
        });
        expect(await assertJson<ImportCountsResult>(await importRequest(alice, secondCalendarId, file))).toEqual({
            imported: 0,
            skipped: 1,
            failed: 0,
        });
    });

    test('an invitation file is stored as plain events: no organizer, no attendees, five reminders', async () => {
        const stamp = randomUUID();
        const uid = `invite-${stamp}@external.com`;
        const alarms = Array.from({ length: 8 }, (_, i) => [
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `TRIGGER:-PT${(i + 1) * 5}M`,
            'DESCRIPTION:Reminder',
            'END:VALARM',
        ]).flat();
        const file = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REQUEST',
            'PRODID:-//Apple Inc.//macOS//EN',
            ...vevent(uid, 'Offsite', '20260407T090000Z', '20260407T100000Z', [
                'ORGANIZER;CN="External Org":mailto:organizer@external.com',
                'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:someone@external.com',
                `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${alice.email}`,
                ...alarms,
            ]),
            'END:VCALENDAR',
        ].join('\r\n');

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 0,
        });

        const stored = findOrFail(await april(), (e) => e.uid === uid);
        expect(stored.data?.organizer).toBeUndefined();
        expect(stored.data?.attendees).toBeUndefined();
        expect(stored.data?.reminders?.length).toBe(5);

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();

        const edited = await authedRequest(
            alice.sessionToken,
            `/calendar/${alice.id}/calendars/${calendarId}/events/${stored.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Offsite (rescheduled)' }),
            },
        );
        expect((await assertJson<CalendarEvent>(edited)).title).toBe('Offsite (rescheduled)');

        const removed = await authedRequest(
            alice.sessionToken,
            `/calendar/${alice.id}/calendars/${calendarId}/events/${stored.id}`,
            { method: 'DELETE' },
        );
        expect(removed.status).toBe(200);
        await new Promise((r) => setTimeout(r, 50));
        expect(spy.mock.calls.length).toBe(0);
        spy.mockRestore();
    });

    test('a forged iMIP REPLY for an imported UID has no attendee list to move', async () => {
        const stamp = randomUUID();
        const uid = `reply-target-${stamp}@external.com`;
        const file = vcal(
            vevent(uid, 'Imported meeting', '20260408T090000Z', '20260408T100000Z', [
                'ORGANIZER;CN="External Org":mailto:organizer@external.com',
                'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:mallory@external.com',
            ]),
        );
        expect((await importRequest(alice, calendarId, file)).status).toBe(200);

        const reply = [
            'From: mallory@external.com',
            `Authentication-Results: ${getMailDomain()}; dkim=pass header.d=external.com`,
            `To: ${alice.email}`,
            'Subject: Accepted: Imported meeting',
            'Date: Mon, 20 Apr 2026 10:00:00 +0000',
            'MIME-Version: 1.0',
            'Content-Type: text/calendar; method=REPLY; charset=utf-8',
            '',
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'METHOD:REPLY',
            'PRODID:-//Mallory//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:Imported meeting',
            'DTSTART:20260408T090000Z',
            'DTEND:20260408T100000Z',
            'ORGANIZER:mailto:organizer@external.com',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:mallory@external.com',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const delivered = await app.handle(
            new Request(`http://localhost/mail/deliver/${alice.email}`, {
                method: 'POST',
                headers: { 'Content-Type': EML_MIME },
                body: reply,
            }),
        );
        expect(delivered.status).toBe(200);

        const stored = findOrFail(await april(), (e) => e.uid === uid);
        expect(stored.data?.attendees).toBeUndefined();
    });

    test('an unusable UID fails while the rest of the file imports', async () => {
        const stamp = randomUUID();
        const file = vcal(
            vevent(`bad/\u0001uid-${stamp}@other`, 'Unusable', '20260409T090000Z', '20260409T100000Z'),
            vevent(`fine-1-${stamp}@other`, 'Fine one', '20260409T110000Z', '20260409T120000Z'),
            vevent(`fine-2-${stamp}@other`, 'Fine two', '20260409T130000Z', '20260409T140000Z'),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 2,
            skipped: 0,
            failed: 1,
        });
        const listed = await april();
        expect(listed.filter((e) => e.uid.includes(stamp)).length).toBe(2);
        expect(listed.some((e) => e.title === 'Unusable')).toBe(false);
    });

    // A whole file used to be "not a calendar" over one VEVENT the parser could not read. Both members it
    // cannot write are counted as failures, and the readable event still lands.
    test('a VEVENT with no start and an override with no master fail while the rest of the file imports', async () => {
        const stamp = randomUUID();
        const file = vcal(
            vevent(`readable-${stamp}@other`, 'Readable', '20260411T090000Z', '20260411T100000Z'),
            ['BEGIN:VEVENT', `UID:no-start-${stamp}@other`, 'SUMMARY:No start at all', 'END:VEVENT'],
            [
                'BEGIN:VEVENT',
                `UID:orphan-${stamp}@other`,
                'RECURRENCE-ID:20260411T110000Z',
                'DTSTART:20260411T120000Z',
                'DTEND:20260411T130000Z',
                'SUMMARY:Override of a series this file does not hold',
                'END:VEVENT',
            ],
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 2,
        });
        const listed = await april();
        expect(listed.filter((e) => e.uid.includes(stamp)).map((e) => e.title)).toEqual(['Readable']);
    });

    test('an event whose end precedes its start fails while the rest of the file imports', async () => {
        const stamp = randomUUID();
        const file = vcal(
            vevent(`reversed-${stamp}@other`, 'Backwards', '20260410T120000Z', '20260410T100000Z'),
            vevent(`forward-${stamp}@other`, 'Forwards', '20260410T140000Z', '20260410T150000Z'),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 1,
        });
        expect((await april()).some((e) => e.title === 'Backwards')).toBe(false);
    });

    test('two series with overrides in one file keep each override on its own master', async () => {
        const stamp = randomUUID();
        const uidA = `series-a-${stamp}@other`;
        const uidB = `series-b-${stamp}@other`;
        const file = vcal(
            vevent(uidA, 'Standup A', '20260413T090000Z', '20260413T093000Z', ['RRULE:FREQ=DAILY;COUNT=5']),
            vevent(uidA, 'Standup A moved', '20260415T110000Z', '20260415T113000Z', ['RECURRENCE-ID:20260415T090000Z']),
            vevent(uidB, 'Standup B', '20260413T100000Z', '20260413T103000Z', ['RRULE:FREQ=DAILY;COUNT=5']),
            vevent(uidB, 'Standup B moved', '20260416T140000Z', '20260416T143000Z', ['RECURRENCE-ID:20260416T100000Z']),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 2,
            skipped: 0,
            failed: 0,
        });

        const listed = await april();
        const seriesA = listed.filter((e) => e.uid === uidA);
        const seriesB = listed.filter((e) => e.uid === uidB);
        expect(seriesA.length).toBe(5);
        expect(seriesB.length).toBe(5);
        expect(findOrFail(seriesA, (e) => e.occurrenceDate === '2026-04-15').title).toBe('Standup A moved');
        expect(findOrFail(seriesB, (e) => e.occurrenceDate === '2026-04-16').title).toBe('Standup B moved');
        // The override of one series must not have re-titled the same day in the other.
        expect(findOrFail(seriesA, (e) => e.occurrenceDate === '2026-04-16').title).toBe('Standup A');
        expect(findOrFail(seriesB, (e) => e.occurrenceDate === '2026-04-15').title).toBe('Standup B');
    });

    // One occurrence is one exception row, whichever writer made it: a CalDAV PUT of a file with two
    // VEVENTs for the same RECURRENCE-ID converges on the last one, so an import lands there in one pass.
    test('two VEVENTs for one occurrence store one exception row, the last one', async () => {
        const uid = `dupe-override-${randomUUID()}@other`;
        const file = vcal(
            vevent(uid, 'Daily', '20260601T090000Z', '20260601T093000Z', ['RRULE:FREQ=DAILY;COUNT=3']),
            vevent(uid, 'First write', '20260602T140000Z', '20260602T150000Z', ['RECURRENCE-ID:20260602T090000Z']),
            vevent(uid, 'Last write', '20260602T160000Z', '20260602T170000Z', ['RECURRENCE-ID:20260602T090000Z']),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 0,
        });

        const home = await getHome(alice.id);
        const rows = home.calendar.getRawEvents(calendarId).filter((e) => e.uid === uid && e.recurrenceDate);
        expect(rows.length).toBe(1);
        expect(rows[0]?.title).toBe('Last write');

        const series = (await calendarRange(calendarId, '2026-06-01T00:00:00Z', '2026-06-05T23:59:59Z')).filter(
            (e) => e.uid === uid,
        );
        expect(series.length).toBe(3);
        expect(findOrFail(series, (e) => e.occurrenceDate === '2026-06-02').title).toBe('Last write');
    });

    test('a series of overrides is one broadcast, and every occurrence matches a CalDAV PUT of the same file', async () => {
        const uid = `overrides-${randomUUID()}@other`;
        const day = (offset: number) =>
            new Date(Date.UTC(2026, 4, 1 + offset)).toISOString().slice(0, 10).replaceAll('-', '');
        const file = vcal(
            vevent(uid, 'Daily', '20260501T090000Z', '20260501T093000Z', [
                'RRULE:FREQ=DAILY;COUNT=55',
                `EXDATE:${day(2)}T090000Z`,
            ]),
            ...Array.from({ length: 50 }, (_, i) =>
                vevent(uid, `Moved ${i}`, `${day(i + 5)}T140000Z`, `${day(i + 5)}T150000Z`, [
                    `RECURRENCE-ID:${day(i + 5)}T090000Z`,
                ]),
            ),
        );

        const sse = collectSSE(alice.id);
        const result = await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file));
        sse.stop();
        expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
        expect(sse.events.filter((e) => e.type === SSEventType.CALENDAR_EVENT_CREATED).length).toBe(1);

        const imported = await calendarRange(calendarId, '2026-05-01T00:00:00Z', '2026-06-30T23:59:59Z');
        const series = imported.filter((e) => e.uid === uid);
        expect(series.length).toBe(54); // 55 occurrences, one dropped by the EXDATE
        expect(series.some((e) => e.occurrenceDate === '2026-05-03')).toBe(false);
        expect(findOrFail(series, (e) => e.occurrenceDate === '2026-05-06').title).toBe('Moved 0');

        // The same file through a CalDAV PUT, the other writer of exception rows.
        const put = await app.handle(
            new Request(`http://localhost/dav/calendars/${alice.id}/${secondCalendarId}/${randomUUID()}.ics`, {
                method: 'PUT',
                headers: { Authorization: `Basic ${btoa(`${alice.email}:${PASSWORD}`)}`, 'Content-Type': ICS_MIME },
                body: file,
            }),
        );
        expect(put.status).toBe(201);

        const throughCalDav = await calendarRange(secondCalendarId, '2026-05-01T00:00:00Z', '2026-06-30T23:59:59Z');
        const shape = (events: CalendarEventOccurrence[]) =>
            events.map((e) => `${e.occurrenceDate} ${e.title} ${new Date(e.startTime).toISOString()}`).sort();
        expect(shape(series)).toEqual(shape(throughCalDav.filter((e) => e.uid === uid)));
    });

    test('imported overrides get a resource name of their own, never one built from the file UID', async () => {
        const uid = `../../weird-${randomUUID()}@other`;
        const file = vcal(
            vevent(uid, 'Traversal', '20260901T090000Z', '20260901T093000Z', ['RRULE:FREQ=DAILY;COUNT=3']),
            vevent(uid, 'Traversal moved', '20260902T110000Z', '20260902T113000Z', ['RECURRENCE-ID:20260902T090000Z']),
        );
        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 0,
        });

        const home = await getHome(alice.id);
        const stored = home.calendar.getEventsByUid(uid);
        expect(stored.length).toBe(2);
        for (const row of stored) expect(row.uri).toMatch(/^[0-9a-f-]{36}\.ics$/);

        const propfind = await app.handle(
            new Request(`http://localhost/dav/calendars/${alice.id}/${calendarId}/`, {
                method: 'PROPFIND',
                headers: {
                    Authorization: `Basic ${btoa(`${alice.email}:${PASSWORD}`)}`,
                    'Content-Type': 'application/xml',
                    Depth: '1',
                },
                body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
            }),
        );
        expect(propfind.status).toBe(207);
        const hrefs = [...(await propfind.text()).matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        for (const href of hrefs) expect(href.startsWith(`/dav/calendars/${alice.id}/${calendarId}/`)).toBe(true);
    });

    test('a series whose override is invalid keeps none of its rows while the rest of the file imports', async () => {
        const stamp = randomUUID();
        const halfUid = `half-${stamp}@other`;
        const wholeUid = `whole-${stamp}@other`;
        const file = vcal(
            vevent(halfUid, 'Half series', '20260801T090000Z', '20260801T093000Z', ['RRULE:FREQ=DAILY;COUNT=5']),
            vevent(halfUid, 'Fine override', '20260802T110000Z', '20260802T113000Z', [
                'RECURRENCE-ID:20260802T090000Z',
            ]),
            vevent(halfUid, 'Backwards override', '20260803T120000Z', '20260803T100000Z', [
                'RECURRENCE-ID:20260803T090000Z',
            ]),
            vevent(wholeUid, 'Whole event', '20260801T100000Z', '20260801T103000Z'),
        );

        expect(await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file))).toEqual({
            imported: 1,
            skipped: 0,
            failed: 1,
        });

        const home = await getHome(alice.id);
        expect(home.calendar.getEventsByUid(halfUid).length).toBe(0);
        expect(home.calendar.getEventsByUid(wholeUid).length).toBe(1);
    });

    test('a crash mid-import leaves the calendar exactly as it was', async () => {
        const stamp = randomUUID();
        const file = vcal(
            ...Array.from({ length: 4 }, (_, i) =>
                vevent(`crash-${i}-${stamp}@other`, `Crash ${i}`, '20261001T090000Z', '20261001T100000Z'),
            ),
        );

        const home = await getHome(alice.id);
        const ctagBefore = home.calendar.getCalendarById(calendarId)!.ctag;
        const original = home.calendar.getEventsByUid.bind(home.calendar);
        let calls = 0;
        const spy = spyOn(home.calendar, 'getEventsByUid').mockImplementation((uid: string) => {
            calls++;
            if (calls === 3) throw new Error('storage went away');
            return original(uid);
        });

        const sse = collectSSE(alice.id);
        const res = await importRequest(alice, calendarId, file);
        sse.stop();
        spy.mockRestore();

        expect(res.status).toBe(500);
        expect(home.calendar.getCalendarById(calendarId)!.ctag).toBe(ctagBefore);
        expect(home.calendar.getRawEvents(calendarId).some((e) => e.uid.includes(stamp))).toBe(false);
        expect(sse.events.filter((e) => e.type === SSEventType.CALENDAR_EVENT_CREATED).length).toBe(0);
    });

    test('a file past the event ceiling is refused before anything is written', async () => {
        const stamp = randomUUID();
        const file = vcal(
            ...Array.from({ length: ICS_IMPORT_MAX_EVENTS + 1 }, (_, i) =>
                vevent(`over-${i}-${stamp}@other`, `Over ${i}`, '20260420T090000Z', '20260420T100000Z'),
            ),
        );

        const res = await importRequest(alice, calendarId, file);
        expect(res.status).toBe(413);
        expect((await april()).some((e) => e.uid.includes(stamp))).toBe(false);
    });

    // The route runs with the idle timeout off, on the one thread that serves every app, and ical.js does
    // not cache a TZID lookup that finds no VTIMEZONE — so a file far past the ceiling must be refused on
    // what it says it holds, not after it is parsed (26 805 such VEVENTs cost 21 s of that thread).
    test('a file far past the ceiling is refused on its VEVENT count, before the parse', async () => {
        const stamp = randomUUID();
        const file = vcal(
            ...Array.from({ length: ICS_IMPORT_MAX_EVENTS * 20 }, (_, i) => [
                'BEGIN:VEVENT',
                `UID:flood-${i}-${stamp}@other`,
                `SUMMARY:Flood ${i}`,
                'DTSTART;TZID=Europe/Amsterdam:20260420T090000',
                'DTEND;TZID=Europe/Amsterdam:20260420T100000',
                'END:VEVENT',
            ]),
        );

        const started = Date.now();
        const res = await importRequest(alice, calendarId, file);
        const elapsed = Date.now() - started;

        expect(res.status).toBe(413);
        expect(elapsed).toBeLessThan(2000);
        expect((await april()).some((e) => e.uid.includes(stamp))).toBe(false);
    });

    test('the ceiling counts every VEVENT: a file of one master and its overrides is refused too', async () => {
        const uid = `flood-${randomUUID()}@other`;
        const file = vcal(
            vevent(uid, 'Flood', '20261101T090000Z', '20261101T093000Z', [
                `RRULE:FREQ=DAILY;COUNT=${ICS_IMPORT_MAX_EVENTS}`,
            ]),
            ...Array.from({ length: ICS_IMPORT_MAX_EVENTS }, (_, i) => {
                const day = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10).replaceAll('-', '');
                return vevent(uid, `Moved ${i}`, `${day}T140000Z`, `${day}T150000Z`, [`RECURRENCE-ID:${day}T090000Z`]);
            }),
        );

        expect((await importRequest(alice, calendarId, file)).status).toBe(413);
        const home = await getHome(alice.id);
        expect(home.calendar.getEventsByUid(uid).length).toBe(0);
    });

    test('a thousand events are one calendar broadcast', async () => {
        const stamp = randomUUID();
        const file = vcal(
            ...Array.from({ length: ICS_IMPORT_MAX_EVENTS }, (_, i) =>
                vevent(`bulk-${i}-${stamp}@other`, `Bulk ${i}`, '20260421T090000Z', '20260421T100000Z'),
            ),
        );

        const sse = collectSSE(alice.id);
        const started = Date.now();
        const result = await assertJson<ImportCountsResult>(await importRequest(alice, calendarId, file));
        const elapsed = Date.now() - started;
        sse.stop();

        expect(result.imported).toBe(ICS_IMPORT_MAX_EVENTS);
        expect(sse.events.filter((e) => e.type === SSEventType.CALENDAR_EVENT_CREATED).length).toBe(1);
        expect(elapsed).toBeLessThan(30_000);
    });

    test('CalDAV clients pick the imported events up', async () => {
        const stamp = randomUUID();
        const syncReport = (token?: string) => `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${token ?? ''}</D:sync-token>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
        const report = (body: string) =>
            app.handle(
                new Request(`http://localhost/dav/calendars/${alice.id}/${calendarId}/`, {
                    method: 'REPORT',
                    headers: {
                        Authorization: `Basic ${btoa(`${alice.email}:${PASSWORD}`)}`,
                        'Content-Type': 'application/xml',
                    },
                    body,
                }),
            );

        const before = await report(syncReport());
        const token = (await before.text()).match(/<D:sync-token>([^<]+)<\/D:sync-token>/)![1];

        const uid = `caldav-${stamp}@other`;
        expect(
            (
                await importRequest(
                    alice,
                    calendarId,
                    vcal(vevent(uid, 'Synced', '20260422T090000Z', '20260422T100000Z')),
                )
            ).status,
        ).toBe(200);

        const imported = findOrFail(await april(), (e) => e.uid === uid);
        const after = await report(syncReport(token));
        expect(after.status).toBe(207);
        expect(await after.text()).toContain(imported.uri);
    });

    test('an imported event gets a resource name of its own, never the file author UID', async () => {
        const uid = `weird/uid with spaces&<${randomUUID()}>@other`;
        expect(
            (
                await importRequest(
                    alice,
                    calendarId,
                    vcal(vevent(uid, 'Odd name', '20260429T090000Z', '20260429T100000Z')),
                )
            ).status,
        ).toBe(200);

        const imported = findOrFail(await april(), (e) => e.uid === uid);
        expect(imported.uri).not.toContain('/');
        expect(imported.uri).not.toContain(uid);

        // The uri is the CalDAV resource name, so a client has to be able to fetch it back.
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${alice.id}/${calendarId}/${imported.uri}`, {
                headers: { Authorization: `Basic ${btoa(`${alice.email}:${PASSWORD}`)}` },
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(uid);
    });

    test('a calendar shared with the caller is not an import target', async () => {
        const shared = await authedRequest(bob.sessionToken, `/calendar/${bob.id}/calendars/${bobCalendarId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shares: [{ targetId: alice.email, permission: 'write' }] }),
        });
        expect(shared.status).toBe(200);

        const res = await importRequest(
            alice,
            bobCalendarId,
            vcal(vevent(`shared-${randomUUID()}@other`, 'Not mine', '20260423T090000Z', '20260423T100000Z')),
        );
        expect(res.status).toBe(404);
    });

    test('an unknown calendar is 404', async () => {
        const res = await importRequest(
            alice,
            randomUUID(),
            vcal(vevent(`unknown-${randomUUID()}@other`, 'Nowhere', '20260424T090000Z', '20260424T100000Z')),
        );
        expect(res.status).toBe(404);
    });

    test('a file that is not a calendar is 400 and nothing is written', async () => {
        const before = (await april()).length;

        const res = await importRequest(alice, calendarId, 'not a calendar, just some bytes\r\n');
        expect(res.status).toBe(400);
        expect((await april()).length).toBe(before);
    });

    // iCalendar is UTF-8 (RFC 5545 §3.1), the same fact a vCard import answers on: the file is refused for
    // its encoding, not lumped in with bytes that are no calendar at all.
    test('a raw import that is not UTF-8 says so, like a vCard import does', async () => {
        const before = (await april()).length;
        // 0xE9 is "é" in Windows-1252 and an invalid UTF-8 byte — the shape of an older client's export.
        const head = new TextEncoder().encode(
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:latin1@other\r\nSUMMARY:Caf',
        );
        const tail = new TextEncoder().encode(
            '\r\nDTSTART:20260427T090000Z\r\nDTEND:20260427T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        );

        const res = await importRequest(alice, calendarId, new Blob([new Uint8Array([...head, 0xe9, ...tail])]));
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('UTF-8');
        expect((await april()).length).toBe(before);
    });

    test('import-from-drive on a file that is not UTF-8 is refused the same way', async () => {
        const head = new TextEncoder().encode(
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:latin1-drive@other\r\nSUMMARY:Caf',
        );
        const tail = new TextEncoder().encode(
            '\r\nDTSTART:20260427T090000Z\r\nDTEND:20260427T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        );
        const file = new File([new Uint8Array([...head, 0xe9, ...tail])], 'latin1.ics', { type: ICS_MIME });
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        const res = await importFromDrive(alice, calendarId, uploaded);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('UTF-8');
    });

    test('a body over ICS_MAX_BYTES is 413 before the body is read', async () => {
        // The body is not a calendar (a 400 if it were ever parsed), so a 413 can only come from the
        // Content-Length check that runs first.
        const res = await importRequest(alice, calendarId, new Blob([new TextEncoder().encode('BEGIN:VCALENDAR')]), {
            'Content-Length': String(ICS_MAX_BYTES + 1),
        });
        expect(res.status).toBe(413);
    });

    test('import-from-drive on own drive imports the file into the calendar', async () => {
        const stamp = randomUUID();
        const uploaded = await uploadIcs(
            vcal(vevent(`drive-${stamp}@other`, 'From Drive', '20260425T090000Z', '20260425T100000Z')),
        );

        const result = await assertJson<ImportCountsResult>(await importFromDrive(alice, calendarId, uploaded));
        expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
        expect((await april()).some((e) => e.uid === `drive-${stamp}@other`)).toBe(true);
    });

    // A file of a thousand events writes a row apiece before the route answers, so it exempts itself from
    // the server-wide idle timeout the way the raw import and both contacts imports do.
    test('import-from-drive exempts its request from the idle timeout', async () => {
        const uploaded = await uploadIcs(
            vcal(vevent(`timeout-${randomUUID()}@other`, 'Long run', '20260428T090000Z', '20260428T100000Z')),
        );
        // app.handle() runs with no server, so the route's `server?.timeout` is a no-op in tests: give the
        // app a real one to observe the call, and take it away again.
        const server = Bun.serve({ port: 0, fetch: () => new Response('') });
        app.server = server;
        const timeout = spyOn(server, 'timeout');
        try {
            expect((await importFromDrive(alice, calendarId, uploaded)).status).toBe(200);
            expect(timeout.mock.calls.map(([, seconds]) => seconds)).toEqual([0]);
        } finally {
            timeout.mockRestore();
            app.server = null;
            server.stop(true);
        }
    });

    test('import-from-drive on a file that is not an .ics is 400', async () => {
        const file = new File(
            [new TextEncoder().encode(vcal(vevent('x@other', 'X', '20260426T090000Z', '20260426T100000Z')))],
            'notes.txt',
            {
                type: 'text/plain',
            },
        );
        const uploaded = await driveUpload(alice.sessionToken, alice.id, mountId, rootId, file);

        expect((await importFromDrive(alice, calendarId, uploaded)).status).toBe(400);
    });

    test('import-from-drive on a folder named like a calendar is 400', async () => {
        const folder = await drivePost<DrivePath>(alice.sessionToken, alice.id, mountId, `folder/${rootId}`, {
            folderName: `folder-${randomUUID()}.ics`,
        });

        expect((await importFromDrive(alice, calendarId, folder)).status).toBe(400);
    });

    test("bob cannot import into alice's calendar", async () => {
        const res = await authedRequest(
            bob.sessionToken,
            `/calendar/${alice.id}/import?calendarId=${encodeURIComponent(calendarId)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': ICS_MIME },
                body: vcal(vevent(`mallory-${randomUUID()}@other`, 'Mallory', '20260427T090000Z', '20260427T100000Z')),
            },
        );
        expect(res.status).toBe(403);
    });

    test('a guest is refused on both import routes', async () => {
        const raw = await authedRequest(
            guestToken,
            `/calendar/${guestId}/import?calendarId=${encodeURIComponent(calendarId)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': ICS_MIME },
                body: vcal(vevent(`guest-${randomUUID()}@other`, 'Guest', '20260428T090000Z', '20260428T100000Z')),
            },
        );
        expect(raw.status).toBe(403);

        const fromDrive = await authedRequest(guestToken, `/calendar/${guestId}/import-from-drive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                calendarId,
                sourceOwnerId: alice.id,
                sourceMountId: mountId,
                sourcePathId: rootId,
            }),
        });
        expect(fromDrive.status).toBe(403);
    });
});
