// Client-faithful CalDAV sync flows against WEB-created events (regression net for the
// 2026-07-13 Thunderbird session): real clients PUT to EXISTING resources and do not
// round-trip STATUS:CANCELLED override VEVENTs, so occurrence deletions must be served as
// EXDATE on the master. Sibling nets: caldav-roundtrip.test.ts (client-created series),
// calendar-timezone.test.ts (occurrence keying).
import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { app, assertJson, authedRequest, getTestContext } from './setup';

function epoch(iso: string): number {
    return Math.floor(Date.parse(iso) / 1000);
}

describe('CalDAV client sync on web-created events', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    let token: string;
    let calendarId: string;

    const basicAuth = (email: string) => `Basic ${btoa(`${email}:testpassword123`)}`;

    async function davPut(uri: string, body: string, ifMatch?: string): Promise<Response> {
        return app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar; charset=utf-8',
                    ...(ifMatch ? { 'If-Match': ifMatch } : {}),
                },
                body,
            }),
        );
    }

    async function davSync(token?: string): Promise<string> {
        const tokenEl = token ? `<D:sync-token>${token}</D:sync-token>` : '<D:sync-token/>';
        const body = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  ${tokenEl}
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(207);
        return res.text();
    }

    async function davGet(uri: string): Promise<{ ics: string; etag: string | null }> {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(200);
        return { ics: await res.text(), etag: res.headers.get('ETag') };
    }

    async function occurrenceDays(uid: string, fromIso: string, toIso: string): Promise<string[]> {
        const res = await authedRequest(token, `/calendar/${userId}/event-range/${epoch(fromIso)}/${epoch(toIso)}`);
        const occ = await assertJson<CalendarEventOccurrence[]>(res);
        return occ.filter((o) => o.uid === uid).map((o) => new Date(o.startTime).toISOString().slice(0, 10));
    }

    async function createWebEvent(body: Record<string, unknown>): Promise<CalendarEvent> {
        const res = await authedRequest(token, `/calendar/${userId}/calendars/${calendarId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return assertJson<CalendarEvent>(res);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;
        token = ctx.alice.user.sessionToken;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        const xml = await res.text();
        const ids = [...xml.matchAll(new RegExp(`/dav/calendars/${userId}/([^/<]+)/`, 'g'))]
            .map((m) => m[1])
            .filter(Boolean);
        calendarId = ids[0];
    });

    test('web move-one-occurrence serializes a linked override', async () => {
        const ev = await createWebEvent({
            title: 'Weekly standup',
            startTime: '2026-07-06T10:00:00.000Z',
            endTime: '2026-07-06T10:30:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
            rrule: 'FREQ=WEEKLY',
        });

        // The web "edit this occurrence" flow: a new event with parentEventId + recurrenceDate.
        await createWebEvent({
            title: 'Weekly standup',
            startTime: '2026-07-14T10:00:00.000Z',
            endTime: '2026-07-14T10:30:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
            rrule: null,
            parentEventId: ev.id,
            recurrenceDate: '2026-07-13',
        });

        const { ics } = await davGet(`${ev.uid}.ics`);
        const vevents = ics.split('BEGIN:VEVENT').slice(1);
        expect(vevents.length).toBe(2);
        const override = vevents.find((v) => v.includes('RECURRENCE-ID'));
        expect(override).toBeDefined();
        // The rid must name the ORIGINAL slot (Monday 12:00 Amsterdam), not the moved time —
        // an unlinked rid makes clients render the original occurrence too.
        const rid = override!.match(/RECURRENCE-ID[^:\r\n]*:([0-9TZ]+)/)?.[1];
        expect(rid).toBe('20260713T120000');
    });

    test('EXDATE added by a client PUT to an existing event cancels the occurrence', async () => {
        const ev = await createWebEvent({
            title: 'Weekly sync',
            startTime: '2026-08-03T10:00:00.000Z',
            endTime: '2026-08-03T10:30:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
            rrule: 'FREQ=WEEKLY',
        });

        const { ics, etag } = await davGet(`${ev.uid}.ics`);
        // Inject into the VEVENT's RRULE — the VTIMEZONE also carries RRULE lines, so a naive
        // first-match injection would land inside the VTIMEZONE and be ignored.
        const withExdate = ics.replace(
            'RRULE:FREQ=WEEKLY',
            'RRULE:FREQ=WEEKLY\r\nEXDATE;TZID=Europe/Amsterdam:20260810T120000',
        );
        expect(withExdate).not.toBe(ics);
        const put = await davPut(`${ev.uid}.ics`, withExdate, etag ?? undefined);
        expect(put.status).toBe(204);

        expect(await occurrenceDays(ev.uid, '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z')).toEqual([
            '2026-08-03',
            '2026-08-17',
            '2026-08-24',
        ]);
    });

    test('web-deleted occurrence survives a client re-PUT that omits cancelled overrides', async () => {
        const ev = await createWebEvent({
            title: 'Weekly review',
            startTime: '2026-09-07T10:00:00.000Z',
            endTime: '2026-09-07T10:30:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
            rrule: 'FREQ=WEEKLY',
        });

        // The web "delete this occurrence" owner flow: a cancelled exception row.
        await createWebEvent({
            title: 'Weekly review',
            startTime: '2026-09-14T10:00:00.000Z',
            endTime: '2026-09-14T10:30:00.000Z',
            allDay: false,
            parentEventId: ev.id,
            recurrenceDate: '2026-09-14',
            status: 'cancelled',
        });
        expect(await occurrenceDays(ev.uid, '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z')).not.toContain(
            '2026-09-14',
        );

        // The deletion must be served as EXDATE on the master; Thunderbird does not round-trip a
        // STATUS:CANCELLED override VEVENT, and the full-replace exception prune would then
        // resurrect the occurrence on TB's next PUT.
        const { ics, etag } = await davGet(`${ev.uid}.ics`);
        expect(ics).toContain('EXDATE;TZID=Europe/Amsterdam:20260914T120000');
        expect(ics).not.toContain('STATUS:CANCELLED');

        // TB re-PUT: served bytes minus any cancelled override VEVENT.
        const lines = ics.split(/\r?\n/);
        const out: string[] = [];
        let block: string[] | null = null;
        for (const line of lines) {
            if (line === 'BEGIN:VEVENT') {
                block = [line];
            } else if (block) {
                block.push(line);
                if (line === 'END:VEVENT') {
                    if (!block.includes('STATUS:CANCELLED')) out.push(...block);
                    block = null;
                }
            } else {
                out.push(line);
            }
        }
        const put = await davPut(`${ev.uid}.ics`, out.join('\r\n'), etag ?? undefined);
        expect(put.status).toBe(204);

        expect(await occurrenceDays(ev.uid, '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z')).not.toContain(
            '2026-09-14',
        );
    });

    test('delete-then-recreate emits a single href in one sync response (no 200 + 404 duplicate)', async () => {
        const uri = 'recreate-single-href.ics';
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:recreate-single-href@eigen',
            'SUMMARY:Recreate Me',
            'DTSTART:20261101T090000Z',
            'DTEND:20261101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const create = await davPut(uri, ics);
        expect([201, 204]).toContain(create.status);

        // The token captured BEFORE the delete: the tombstone and the re-created event both fall after it, so
        // pre-fix this href would come back as both a 200 (changed) and a 404 (deleted).
        const preToken = (await davSync()).match(/<D:sync-token>([^<]+)<\/D:sync-token>/)![1];

        const del = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/${uri}`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(del.status).toBe(204);
        const recreate = await davPut(uri, ics);
        expect(recreate.status).toBe(201);

        const xml = await davSync(preToken);
        // The href appears exactly once, and never as a 404 tombstone row.
        expect(xml.split(uri).length - 1).toBe(1);
        expect(xml).not.toContain('404 Not Found');
    });

    test('a sync token ahead of the calendar ctag is refused, never answered with an empty delta', async () => {
        // A post-restore client presents a token minted against a higher ctag; an empty delta plus a LOWER
        // token would stall it forever, so the guard must refuse like a malformed token does.
        const current = /urn:eigen:sync:(\d+)/.exec(await davSync());
        expect(current).not.toBeNull();
        const body = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>urn:eigen:sync:${Number(current![1]) + 1000}</D:sync-token>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('valid-sync-token');
    });

    test('client drag of a simple event (If-Match PUT of served bytes) sticks', async () => {
        const ev = await createWebEvent({
            title: 'Dentist',
            startTime: '2026-07-20T08:00:00.000Z',
            endTime: '2026-07-20T09:00:00.000Z',
            allDay: false,
            timezone: 'Europe/Amsterdam',
        });

        const { ics, etag } = await davGet(`${ev.uid}.ics`);
        expect(etag).toBeTruthy();

        const moved = ics.replace(/20260720T/g, '20260721T');
        const put = await davPut(`${ev.uid}.ics`, moved, etag ?? undefined);
        expect(put.status).toBe(204);

        expect(await occurrenceDays(ev.uid, '2026-07-19T00:00:00Z', '2026-07-23T00:00:00Z')).toEqual(['2026-07-21']);
    });
});
