import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Calendar } from '../../lib/calendar/calendar';
import { parseIcs } from '../../lib/ical';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { calendarsDirOf, makeCalendar } from '../calendar-test-helpers';
import type { TestHome } from '../home-test-helpers';
import { vcal } from '../ics-test-helpers';

// The one decision an inbound iMIP REQUEST takes (L36): update the copy it is linked to, adopt an event
// this Home already holds when the verified sender is the organizer it names, or drop it — never a second
// master for one UID.

const ORG = 'organizer@external.com';
const OTHER = 'someone.else@external.com';
const UID = 'inbound-request@external.com';

const request = (extra: string[] = [], organizer = ORG, uid = UID): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'SUMMARY:Quarterly review',
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        'SEQUENCE:2',
        `ORGANIZER;CN=Ext Org:mailto:${organizer}`,
        'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:owner@test.local',
        'DTSTAMP:20260101T000000Z',
        ...extra,
        'END:VEVENT',
    ]);

const parsedOf = (ics: string): ParsedEvent => parseIcs(ics).events[0];

// An event the Home already holds, written by its own client: an ORGANIZER address and no link.
const stored = (organizer: string | null, uid = UID): string =>
    vcal([
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'SUMMARY:Quarterly review (mine)',
        'DTSTART:20260501T090000Z',
        'DTEND:20260501T100000Z',
        ...(organizer ? [`ORGANIZER;CN=Ext Org:mailto:${organizer}`] : []),
        'DTSTAMP:20260101T000000Z',
        'END:VEVENT',
    ]);

async function harnessWith(body?: string): Promise<{ harness: TestHome<Calendar>; calendar: Calendar; id: string }> {
    const harness = await makeCalendar();
    const calendar = harness.instance;
    const id = (await calendar.getCalendars())[0].id;
    if (body) expect((await calendar.putResource(id, 'mine.ics', body, NO_PRECONDITIONS)).ok).toBe(true);
    return { harness, calendar, id };
}

const NO_PRECONDITIONS = { ifMatch: null, ifNoneMatch: null };

describe('inbound iMIP REQUEST', () => {
    beforeAll(() => {
        rmSync(join(import.meta.dir, '../../../../../data-test'), { recursive: true, force: true });
    });

    test('the organizer a stored event names adopts it in place', async () => {
        const { calendar, id } = await harnessWith(stored(ORG));
        const before = (await calendar.getRawEvents(id))[0];

        await calendar.receiveImipRequest(parsedOf(request()), ORG);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        // Same row, same file: an adoption is a write of the resource the Home already had.
        expect(rows[0].id).toBe(before.id);
        expect(rows[0].uri).toBe('mine.ics');
        expect(rows[0].data?.organizerEventId).toBe(UID);
        expect(rows[0].data?.organizer?.userId).toBe(`external_${ORG}`);
        expect(rows[0].data?.attendees?.[0].email).toBe('owner@test.local');
        expect(rows[0].title).toBe('Quarterly review');
        expect(rows[0].sequence).toBe(2);
    });

    test('the address an imported event was filed under adopts it too', async () => {
        const harness = await makeCalendar();
        const id = (await harness.instance.getCalendars())[0].id;
        // Stage 7's import writes this stamp; a planted file stands in for one, indexed by the reconcile.
        const planted = stored(null)
            .replace('DTSTAMP:20260101T000000Z', `X-EIGEN-IMPORTED-ORGANIZER:${ORG}\r\nDTSTAMP:20260101T000000Z`)
            .concat('\r\n');
        mkdirSync(join(calendarsDirOf(harness.dir), id), { recursive: true });
        writeFileSync(join(calendarsDirOf(harness.dir), id, 'imported.ics'), planted);

        const restarted = await harness.reopen();
        try {
            await restarted.instance.receiveImipRequest(parsedOf(request()), ORG);
            const rows = await restarted.instance.getEventsByUid(UID);
            expect(rows).toHaveLength(1);
            expect(rows[0].uri).toBe('imported.ics');
            expect(rows[0].data?.organizerEventId).toBe(UID);
        } finally {
            await restarted.close();
        }
    });

    test('a sender the stored event does not name is dropped', async () => {
        const { calendar, id } = await harnessWith(stored(ORG));

        await calendar.receiveImipRequest(parsedOf(request([], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizerEventId).toBeUndefined();
        expect(rows[0].title).toBe('Quarterly review (mine)');
        expect(await calendar.listResources(id)).toHaveLength(1);
    });

    test('a REQUEST for a UID linked to another organizer is dropped', async () => {
        const { calendar } = await harnessWith();
        await calendar.receiveImipRequest(parsedOf(request()), ORG);

        // A co-attendee re-sending the same series must not take the invitation over.
        await calendar.receiveImipRequest(parsedOf(request(['SEQUENCE:9'], OTHER)), OTHER);

        const rows = await calendar.getEventsByUid(UID);
        expect(rows).toHaveLength(1);
        expect(rows[0].data?.organizer?.email).toBe(ORG);
        expect(rows[0].sequence).toBe(2);
    });

    test('a body whose ORGANIZER is not the sender never becomes an invitation', async () => {
        const { calendar, id } = await harnessWith();

        await calendar.receiveImipRequest(parsedOf(request([], ORG)), OTHER);

        expect(await calendar.getEventsByUid(UID)).toHaveLength(0);
        expect(await calendar.listResources(id)).toHaveLength(0);
    });

    test('two concurrent deliveries of one REQUEST leave one resource', async () => {
        const { calendar, id } = await harnessWith();
        const parsed = parsedOf(request());

        await Promise.all([calendar.receiveImipRequest(parsed, ORG), calendar.receiveImipRequest(parsed, ORG)]);

        expect(await calendar.listResources(id)).toHaveLength(1);
        expect(await calendar.getEventsByUid(UID)).toHaveLength(1);
    });
});
