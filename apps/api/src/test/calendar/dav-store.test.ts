import { beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import type { Calendar } from '../../lib/calendar/calendar';
import { EVENT_MAX_BYTES } from '../../lib/calendar/resource-store';
import * as schema from '../../lib/calendar/schema';
import { CALENDAR_TEST_ROOT, makeCalendar, resourceTextOf, storedEvents } from '../calendar-test-helpers';
import { cpuClock } from '../cpu-time';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The CalDAV seam over the store: what a PUT is allowed to land, what it refuses, and what the stored
// bytes look like afterwards. See docs/CALDAV.md § A PUT is judged inside the write lock.

const event = (uid: string, summary: string, extra: string[] = []): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20260401T100000Z',
    'DTEND:20260401T110000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
];

const put = (calendar: Calendar, calendarId: string, uri: string, body: string) =>
    calendar.putResource(calendarId, uri, body, { ifMatch: null, ifNoneMatch: null });

async function defaultCalendarId(harness: TestHome<Calendar>): Promise<string> {
    return (await harness.instance.getCalendars())[0].id;
}

describe('putResource', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('a write past the resource ceiling answers 413 and stores nothing', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        const write = harness.instance.createEvent(calendarId, {
            title: 'Too big',
            description: 'x'.repeat(EVENT_MAX_BYTES),
            startTime: new Date('2026-04-01T10:00:00Z'),
            endTime: new Date('2026-04-01T11:00:00Z'),
            allDay: false,
        });

        expect(write).rejects.toMatchObject({ status: 413 });
        await write.catch(() => {});
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
        expect(await harness.instance.size()).toBe(0);
    });

    test('a UID no index can carry is refused at the put seam, so every surface answers alike', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        for (const uid of [`${'x'.repeat(256)}@eigen`, 'bell\u0007@eigen']) {
            const result = await put(harness.instance, calendarId, 'uid.ics', vcal(event(uid, 'Unstorable')));
            expect(result).toMatchObject({ ok: false, error: 'invalid', reason: 'data' });
        }
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
    });

    test('a body nested past the limit is refused as invalid data', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const levels = 20;
        const body = vcal(
            event('nested@eigen', 'Nested', [
                ...Array<string>(levels).fill('BEGIN:X-LEVEL'),
                ...Array<string>(levels).fill('END:X-LEVEL'),
            ]),
        );

        const result = await put(harness.instance, calendarId, 'nested.ics', body);
        expect(result).toMatchObject({ ok: false, error: 'invalid', reason: 'data' });
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
    });

    test('a resource that ends before it starts is refused, where a zero-length one is stored', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const bounds = (uid: string, lines: string[]) =>
            vcal(['BEGIN:VEVENT', `UID:${uid}`, ...lines, 'SUMMARY:Bounded', 'END:VEVENT']);

        for (const [uid, lines] of [
            ['reversed@eigen', ['DTSTART:20260401T110000Z', 'DTEND:20260401T100000Z']],
            ['negative@eigen', ['DTSTART:20260401T110000Z', 'DURATION:-PT1H']],
        ] as const) {
            const result = await put(harness.instance, calendarId, 'bounds.ics', bounds(uid, [...lines]));
            expect(result).toMatchObject({ ok: false, error: 'invalid', reason: 'data' });
        }

        // RFC 5545 §3.6.1 allows DTEND = DTSTART, and clients in the wild write it.
        const zero = bounds('zero@eigen', ['DTSTART:20260401T100000Z', 'DTEND:20260401T100000Z']);
        expect((await put(harness.instance, calendarId, 'zero.ics', zero)).ok).toBe(true);
        expect((await harness.instance.listResources(calendarId)).map((r) => r.uri)).toEqual(['zero.ics']);
    });

    test('a name the shared segment rule refuses is never rewritten', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const body = vcal(event('unsafe@eigen', 'Unsafe'));

        for (const uri of ['../escape.ics', 'x', 'plain.txt', `${'x'.repeat(300)}.ics`, 'calendar.db', '.hidden.ics']) {
            const result = await put(harness.instance, calendarId, uri, body);
            expect(result).toEqual({ ok: false, error: 'invalid' });
        }
        expect(await harness.instance.listResources(calendarId)).toHaveLength(0);
    });

    test('a case-variant name is a resource of its own, not a rewrite of the stored one', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'Case-Fold.ics', vcal(event('case-a@eigen', 'First')));

        expect(
            (await put(harness.instance, calendarId, 'case-fold.ics', vcal(event('case-b@eigen', 'Second')))).ok,
        ).toBe(true);

        expect((await harness.instance.listResources(calendarId)).map((r) => r.uri).sort()).toEqual([
            'Case-Fold.ics',
            'case-fold.ics',
        ]);
        expect(await resourceTextOf(harness.instance, calendarId, 'Case-Fold.ics')).toContain('SUMMARY:First');
    });

    test('a PUT of what is already stored bumps no ctag and announces nothing', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'same.ics', vcal(event('same@eigen', 'Same')));
        const stored = await resourceTextOf(harness.instance, calendarId, 'same.ics');
        const ctag = (await harness.instance.getCollection(calendarId))!.ctag;
        harness.broadcasts.length = 0;

        const result = await put(harness.instance, calendarId, 'same.ics', stored);

        expect(result).toMatchObject({ ok: true, created: false, unchanged: true });
        expect((await harness.instance.getCollection(calendarId))!.ctag).toBe(ctag);
        expect(harness.broadcasts).toEqual([]);
    });

    test('a put answers with the id of the row it landed on, a rewrite included', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        const created = await put(harness.instance, calendarId, 'landed.ics', vcal(event('landed@eigen', 'Landed')));
        const stored = (await harness.instance.getResourceMeta(calendarId, 'landed.ics'))!;
        const rewritten = await put(harness.instance, calendarId, 'landed.ics', vcal(event('landed@eigen', 'Again')));

        expect(created).toMatchObject({ ok: true, id: stored.id, created: true });
        expect(rewritten).toMatchObject({ ok: true, id: stored.id, created: false, unchanged: false });
    });

    test('a linked copy takes the alarms a client sends, never the Eigen lines inside them', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'linked.ics', vcal(event('linked@eigen', 'Linked')));
        // The organizer stamp the server writes on an attendee's copy: a PUT may re-alarm it and no more.
        calendar.db
            .update(schema.resources)
            .set({
                ics: sql`CAST(replace(CAST(${schema.resources.ics} AS TEXT), 'SUMMARY:Linked', 'SUMMARY:Linked\r\nX-EIGEN-ORGANIZER-EVENT:organizer-1') AS BLOB)`,
            })
            .where(eq(schema.resources.uri, 'linked.ics'))
            .run();

        const result = await put(
            calendar,
            calendarId,
            'linked.ics',
            vcal(
                event('linked@eigen', 'Renamed', [
                    'BEGIN:VALARM',
                    'ACTION:DISPLAY',
                    'DESCRIPTION:Reminder',
                    'TRIGGER:-PT10M',
                    'X-EIGEN-EVENT-ID:forged-by-the-client',
                    'END:VALARM',
                ]),
            ),
        );
        expect(result.ok).toBe(true);

        const stored = await resourceTextOf(calendar, calendarId, 'linked.ics');
        expect(stored).toContain('TRIGGER:-PT10M');
        expect(stored).toContain('SUMMARY:Linked');
        expect(stored).not.toContain('forged-by-the-client');
    });

    test('a linked copy adopts a long run of alarms behind other subcomponents in one pass', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'linked.ics', vcal(event('linked@eigen', 'Linked')));
        calendar.db
            .update(schema.resources)
            .set({
                ics: sql`CAST(replace(CAST(${schema.resources.ics} AS TEXT), 'SUMMARY:Linked', 'SUMMARY:Linked\r\nX-EIGEN-ORGANIZER-EVENT:organizer-1') AS BLOB)`,
            })
            .where(eq(schema.resources.uri, 'linked.ics'))
            .run();
        const count = 30_000;
        const body = vcal(
            event('linked@eigen', 'Linked', [
                ...Array<string>(count).fill('BEGIN:X-FIRST\r\nEND:X-FIRST'),
                ...Array<string>(count).fill('BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM'),
            ]),
        );

        const cpuMs = cpuClock();
        const result = await put(calendar, calendarId, 'linked.ics', body);
        expect(cpuMs()).toBeLessThan(1_500);

        expect(result.ok).toBe(true);
        const stored = await resourceTextOf(calendar, calendarId, 'linked.ics');
        expect(stored.match(/BEGIN:VALARM/g)).toHaveLength(count);
        expect(stored).not.toContain('X-FIRST');
    });

    test('a linked copy refuses a body whose occurrence no key can name, and keeps its bytes', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        await put(calendar, calendarId, 'linked.ics', vcal(event('linked@eigen', 'Linked')));
        calendar.db
            .update(schema.resources)
            .set({
                ics: sql`CAST(replace(CAST(${schema.resources.ics} AS TEXT), 'SUMMARY:Linked', 'SUMMARY:Linked\r\nX-EIGEN-ORGANIZER-EVENT:organizer-1') AS BLOB)`,
            })
            .where(eq(schema.resources.uri, 'linked.ics'))
            .run();
        const before = await resourceTextOf(calendar, calendarId, 'linked.ics');

        // 31 December 9999 23:00Z is already 1 January 10000 in Tokyo.
        const result = await put(
            calendar,
            calendarId,
            'linked.ics',
            vcal(
                [
                    'BEGIN:VEVENT',
                    'UID:linked@eigen',
                    'DTSTART;TZID=Asia/Tokyo:20260401T100000',
                    'RRULE:FREQ=WEEKLY',
                    'END:VEVENT',
                ],
                [
                    'BEGIN:VEVENT',
                    'UID:linked@eigen',
                    'RECURRENCE-ID:99991231T230000Z',
                    'DTSTART:99991231T230000Z',
                    'END:VEVENT',
                ],
            ),
        );
        expect(result).toMatchObject({ ok: false, error: 'invalid' });
        expect(await resourceTextOf(calendar, calendarId, 'linked.ics')).toBe(before);
    });

    test('a resource with two masters for one UID is refused, where an override-only one stands alone', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        // RFC 4791 § 4.1 allows a resource that holds overrides only; its override is an event of its own.
        const result = await put(
            harness.instance,
            calendarId,
            'detached.ics',
            vcal([
                'BEGIN:VEVENT',
                'UID:detached@eigen',
                'RECURRENCE-ID:20260408T100000Z',
                'DTSTART:20260408T140000Z',
                'DTEND:20260408T150000Z',
                'SUMMARY:Detached',
                'END:VEVENT',
            ]),
        );
        expect(result.ok).toBe(true);
        const detached = storedEvents(harness.instance, calendarId).find((r) => r.uid === 'detached@eigen')!;
        expect(detached.recurrenceDate).toBe('2026-04-08');
        expect(detached.parentEventId).toBeNull();

        // A PUT is all-or-nothing, so a second master of one UID makes the whole payload malformed.
        const twins = await put(
            harness.instance,
            calendarId,
            'twins.ics',
            vcal(
                event('twins@eigen', 'First master', [
                    `X-EIGEN-EVENT-ID:${crypto.randomUUID()}`,
                    'RRULE:FREQ=WEEKLY;COUNT=3',
                ]),
                event('twins@eigen', 'Second master', [
                    `X-EIGEN-EVENT-ID:${crypto.randomUUID()}`,
                    'RRULE:FREQ=WEEKLY;COUNT=3',
                ]),
            ),
        );
        expect(twins).toMatchObject({ ok: false, error: 'invalid', reason: 'object' });
        expect((await harness.instance.listResources(calendarId)).map((r) => r.uri)).toEqual(['detached.ics']);
    });
});

// L37: parentEventId selects WHICH resource is written, so it is checked inside the lock against the
// calendar the caller named.
describe('an override names its parent', () => {
    const recurring = (uid: string) => vcal(event(uid, 'Weekly', ['RRULE:FREQ=WEEKLY;COUNT=5']));

    test("a parent in another calendar of the home is not this calendar's to override", async () => {
        const harness = await makeCalendar();
        const source = await defaultCalendarId(harness);
        const other = (await harness.instance.createCalendar({ name: 'Other', color: '#2563eb' })).id;
        await put(harness.instance, source, 'series.ics', recurring('parented@eigen'));
        const parent = storedEvents(harness.instance, source)[0];

        await expect(
            harness.instance.createEvent(other, {
                title: 'Moved occurrence',
                startTime: new Date('2026-04-08T12:00:00Z'),
                endTime: new Date('2026-04-08T13:00:00Z'),
                allDay: false,
                parentEventId: parent.id,
                recurrenceDate: '2026-04-08',
            }),
        ).rejects.toThrow('Event not found');
        expect(await harness.instance.listResources(other)).toHaveLength(0);
    });

    test('a second override of one occurrence replaces the first', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'series.ics', recurring('override-twice@eigen'));
        const parent = storedEvents(harness.instance, calendarId)[0];
        const override = (title: string) =>
            harness.instance.createEvent(calendarId, {
                title,
                startTime: new Date('2026-04-08T12:00:00Z'),
                endTime: new Date('2026-04-08T13:00:00Z'),
                allDay: false,
                parentEventId: parent.id,
                recurrenceDate: '2026-04-08',
            });

        await override('First take');
        await override('Second take');

        const exceptions = storedEvents(harness.instance, calendarId).filter((e) => e.parentEventId);
        expect(exceptions.map((e) => e.title)).toEqual(['Second take']);
        expect(await harness.instance.listResources(calendarId)).toHaveLength(1);
    });
});

describe('a query window wider than one expansion', () => {
    const CAREER = [new Date('2010-01-01T00:00:00Z'), new Date('2040-01-01T00:00:00Z')] as const;
    const at = (uid: string, start: string, extra: string[] = []) =>
        vcal([
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTART:${start}T100000Z`,
            `DTEND:${start}T110000Z`,
            'SUMMARY:Wide',
            ...extra,
            'END:VEVENT',
        ]);

    test('still finds every single event in it', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'soon.ics', at('soon', '20261110'));
        await put(harness.instance, calendarId, 'far.ics', at('far', '20350110'));

        const found = await harness.instance.getResourcesInRange(calendarId, ...CAREER);

        expect(found.map((r) => r.uri).sort()).toEqual(['far.ics', 'soon.ics']);
    });

    test('expands a series from where it starts, and at most five years of it', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await put(harness.instance, calendarId, 'series.ics', at('series', '20300101', ['RRULE:FREQ=YEARLY']));

        const found = await harness.instance.getEventsInRange(...CAREER, calendarId);

        expect(found.map((e) => e.occurrenceDate)).toEqual([
            '2030-01-01',
            '2031-01-01',
            '2032-01-01',
            '2033-01-01',
            '2034-01-01',
            '2035-01-01',
        ]);
    });

    test('still finds an occurrence moved past those five years', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const body = vcal([
            'BEGIN:VEVENT',
            'UID:moved',
            'DTSTART:20300101T100000Z',
            'DTEND:20300101T110000Z',
            'SUMMARY:Wide',
            'RRULE:FREQ=YEARLY;COUNT=2',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:moved',
            'RECURRENCE-ID:20310101T100000Z',
            'DTSTART:20380101T100000Z',
            'DTEND:20380101T110000Z',
            'SUMMARY:Wide, moved',
            'END:VEVENT',
        ]);
        await put(harness.instance, calendarId, 'moved.ics', body);

        const found = await harness.instance.getEventsInRange(...CAREER, calendarId);

        expect(found.map((e) => e.startTime.getUTCFullYear())).toEqual([2030, 2038]);
    });
});
