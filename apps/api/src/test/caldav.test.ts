import { beforeAll, describe, expect, test } from 'bun:test';
import { app, getTestContext } from './setup';

describe('CalDAV', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    let defaultCalendarId: string;

    const basicAuth = (email: string, password = 'testpassword123') => `Basic ${btoa(`${email}:${password}`)}`;

    beforeAll(async () => {
        ctx = await getTestContext();
        userId = ctx.alice.user.id;

        // Find default calendar
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        const xml = await res.text();
        // Extract first real calendar ID — skip the home collection entry (trailing slash only)
        // and find hrefs that contain a sub-path like /<calendarId>/
        const matches = xml.matchAll(new RegExp(`/dav/calendars/${userId}/([^/<]+)/`, 'g'));
        const ids = [...matches].map((m) => m[1]).filter(Boolean);
        expect(ids.length).toBeGreaterThan(0);
        defaultCalendarId = ids[0];
    });

    test('OPTIONS returns DAV header', async () => {
        const res = await app.handle(new Request('http://localhost/dav/', { method: 'OPTIONS' }));
        // Elysia returns 204 for empty-body OPTIONS responses
        expect([200, 204]).toContain(res.status);
        expect(res.headers.get('DAV')).toContain('calendar-access');
        expect(res.headers.get('Allow')).toContain('PROPFIND');
    });

    test('PROPFIND /dav/ returns current-user-principal', async () => {
        const res = await app.handle(
            new Request('http://localhost/dav/', {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`/dav/principals/${userId}/`);
        expect(xml).toContain('current-user-principal');
    });

    test('PROPFIND /dav/ without auth returns 401', async () => {
        const res = await app.handle(new Request('http://localhost/dav/', { method: 'PROPFIND' }));
        expect(res.status).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
    });

    test('PROPFIND principals returns calendar-home-set', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/principals/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain(`/dav/calendars/${userId}/`);
        expect(xml).toContain('calendar-home-set');
    });

    test('PROPFIND calendar home lists calendars', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('calendar');
        expect(xml).toContain('displayname');
        // macOS Contacts/Calendar keys on this to pick sync-collection.
        expect(xml).toContain('supported-report-set');
    });

    test('PUT creates event, GET retrieves it', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Test//Test//EN',
            'BEGIN:VEVENT',
            'UID:caldav-test-1@eigen',
            'SUMMARY:CalDAV Test Event',
            'DTSTART:20260401T100000Z',
            'DTEND:20260401T110000Z',
            'STATUS:CONFIRMED',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        // PUT to create
        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-test-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar; charset=utf-8',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );
        expect(putRes.status).toBe(201);
        const etag = putRes.headers.get('ETag');
        expect(etag).toBeTruthy();

        // GET to verify
        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-test-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(getRes.status).toBe(200);
        const body = await getRes.text();
        expect(body).toContain('CalDAV Test Event');
        expect(body).toContain('VCALENDAR');
        expect(getRes.headers.get('Content-Type')).toContain('text/calendar');
    });

    test('PUT with If-None-Match: * fails for existing event', async () => {
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-test-1@eigen\r\nSUMMARY:Duplicate\r\nDTSTART:20260401T100000Z\r\nDTEND:20260401T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-test-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );
        expect(res.status).toBe(412); // Precondition Failed
    });

    test('DELETE removes event', async () => {
        const delRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-test-1.ics`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(delRes.status).toBe(204);

        // Verify it's gone
        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-test-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(getRes.status).toBe(404);
    });

    test('PUT all-day event stores correct UTC midnight times', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-allday-1@eigen',
            'SUMMARY:All Day Event',
            'DTSTART;VALUE=DATE:20260415',
            'DTEND;VALUE=DATE:20260416',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-allday-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: ics,
            }),
        );

        // Fetch via REST API to check stored values
        const res = await app.handle(
            new Request(`http://localhost/calendar/${userId}/event-range/1773964800/1776643200`, {
                headers: { Cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}` },
            }),
        );
        const events = (await res.json()) as { title: string; allDay: boolean; startTime: string; endTime: string }[];
        const allDayEvent = events.find((e) => e.title === 'All Day Event');
        expect(allDayEvent).toBeDefined();
        expect(allDayEvent!.allDay).toBe(true);
        // April 15 00:00:00 UTC
        expect(new Date(allDayEvent!.startTime).toISOString()).toBe('2026-04-15T00:00:00.000Z');
        // April 16 00:00:00 UTC (exclusive end)
        expect(new Date(allDayEvent!.endTime).toISOString()).toBe('2026-04-16T00:00:00.000Z');
    });

    test('recurring event exception sync — master etag changes when exception created', async () => {
        // Create a recurring event
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-recur-1@eigen',
            'SUMMARY:Daily Standup',
            'DTSTART:20260401T090000Z',
            'DTEND:20260401T093000Z',
            'RRULE:FREQ=DAILY;COUNT=5',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-recur-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: ics,
            }),
        );
        expect(putRes.status).toBe(201);
        const originalEtag = putRes.headers.get('ETag');

        // PUT again with an exception (cancel April 3)
        const icsWithException = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-recur-1@eigen',
            'SUMMARY:Daily Standup',
            'DTSTART:20260401T090000Z',
            'DTEND:20260401T093000Z',
            'RRULE:FREQ=DAILY;COUNT=5',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:caldav-recur-1@eigen',
            'RECURRENCE-ID:20260403T090000Z',
            'SUMMARY:Daily Standup',
            'DTSTART:20260403T090000Z',
            'DTEND:20260403T093000Z',
            'STATUS:CANCELLED',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const updateRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-recur-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: icsWithException,
            }),
        );
        expect(updateRes.status).toBe(204);

        // GET the event — the cancelled exception round-trips as EXDATE on the master, not as a
        // STATUS:CANCELLED override VEVENT (clients like Thunderbird drop those from their next PUT).
        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-recur-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body = await getRes.text();
        expect(body).toContain('RRULE:FREQ=DAILY');
        expect(body).toContain('EXDATE:20260403T090000Z');
        expect(body).not.toContain('RECURRENCE-ID');

        // The master event's etag should have changed (so CalDAV clients detect the change)
        const newEtag = getRes.headers.get('ETag');
        expect(newEtag).not.toBe(originalEtag);
    });

    test('cross-user access denied', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${ctx.bob.user.id}/`, {
                method: 'PROPFIND',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    Depth: '1',
                },
            }),
        );
        expect(res.status).toBe(403);
    });

    test('sync-collection returns events created after sync token', async () => {
        // Get initial sync token
        const initialReport = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token/>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;

        const initialRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                },
                body: initialReport,
            }),
        );
        expect(initialRes.status).toBe(207);
        const initialXml = await initialRes.text();
        const tokenMatch = initialXml.match(/<D:sync-token>([^<]+)<\/D:sync-token>/);
        expect(tokenMatch).toBeTruthy();
        const syncToken = tokenMatch![1];

        // Create a new event
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sync-test-1@eigen\r\nSUMMARY:Sync Test\r\nDTSTART:20260601T100000Z\r\nDTEND:20260601T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';

        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/sync-test-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );

        // Incremental sync — should return the new event
        const incrementalReport = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken}</D:sync-token>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;

        const syncRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                },
                body: incrementalReport,
            }),
        );
        expect(syncRes.status).toBe(207);
        const syncXml = await syncRes.text();
        expect(syncXml).toContain('sync-test-1.ics');
    });

    test('sync-collection returns events updated after sync token', async () => {
        // Get current sync token
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token/>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;

        const initialRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                },
                body: reportBody,
            }),
        );
        const initialXml = await initialRes.text();
        const syncToken = initialXml.match(/<D:sync-token>([^<]+)<\/D:sync-token>/)![1];

        // Update an existing event (sync-test-1 from previous test)
        const updatedIcs =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sync-test-1@eigen\r\nSUMMARY:Sync Test Updated\r\nDTSTART:20260601T100000Z\r\nDTEND:20260601T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';

        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/sync-test-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: updatedIcs,
            }),
        );

        // Sync should return the updated event
        const syncReport = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken}</D:sync-token>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;

        const syncRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                },
                body: syncReport,
            }),
        );
        const syncXml = await syncRes.text();
        expect(syncXml).toContain('sync-test-1.ics');
    });

    test('PUT preserves SEQUENCE from ICS', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:seq-preserve-test@eigen',
            'SUMMARY:Sequence Preserve',
            'DTSTART:20260501T100000Z',
            'DTEND:20260501T110000Z',
            'SEQUENCE:5',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        // Create
        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/seq-preserve.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );
        expect(putRes.status).toBe(201);

        // GET and verify sequence is preserved
        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/seq-preserve.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body = await getRes.text();
        expect(body).toContain('SEQUENCE:5');

        // Update with new sequence
        const updatedIcs = ics.replace('SEQUENCE:5', 'SEQUENCE:7').replace('Sequence Preserve', 'Sequence Updated');
        const updateRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/seq-preserve.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: updatedIcs,
            }),
        );
        expect(updateRes.status).toBe(204);

        // Verify new sequence is preserved
        const getRes2 = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/seq-preserve.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body2 = await getRes2.text();
        expect(body2).toContain('SEQUENCE:7');
    });

    test('ETag is stable on identical re-PUT', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:etag-stable-test@eigen',
            'SUMMARY:ETag Stability',
            'DTSTART:20260501T100000Z',
            'DTEND:20260501T110000Z',
            'SEQUENCE:1',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        // Create
        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/etag-stable.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );
        expect(putRes.status).toBe(201);
        const etag1 = putRes.headers.get('ETag');

        // Re-PUT identical content
        const putRes2 = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/etag-stable.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-Match': etag1!,
                },
                body: ics,
            }),
        );
        expect(putRes2.status).toBe(204);
        const etag2 = putRes2.headers.get('ETag');

        // ETags should be identical — no spurious re-PUT loop
        expect(etag2).toBe(etag1);
    });

    test('REPORT calendar-multiget returns requested events', async () => {
        // Create an event first
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-report-1@eigen\r\nSUMMARY:Report Test\r\nDTSTART:20260501T090000Z\r\nDTEND:20260501T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';

        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-report-1.ics`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                },
                body: ics,
            }),
        );

        // REPORT calendar-multiget
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <D:href>/dav/calendars/${userId}/${defaultCalendarId}/caldav-report-1.ics</D:href>
</C:calendar-multiget>`;

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'application/xml',
                },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('Report Test');
        expect(xml).toContain('getetag');
    });

    test('REPORT calendar-query with a basic-format time-range returns in-window events', async () => {
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-timerange-1@eigen\r\nSUMMARY:TimeRange Hit\r\nDTSTART:20260601T090000Z\r\nDTEND:20260601T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-timerange-1.ics`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );

        // RFC 5545 BASIC-format bounds that bracket the event (new Date() reads these as Invalid Date).
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="20260601T000000Z" end="20260602T000000Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        // Pre-fix the Invalid Date bounds emptied the REPORT; the in-window event must appear.
        expect(xml).toContain('TimeRange Hit');
    });

    test('REPORT calendar-query time-range excludes out-of-window events', async () => {
        // A window a year after the caldav-timerange-1 event must NOT return it — proves the parsed
        // range is actually applied, not ignored.
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="20270601T000000Z" end="20270602T000000Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).not.toContain('TimeRange Hit');
    });

    test('PUT with a sub-daily RRULE degrades instead of 500-ing (finding 19)', async () => {
        // DTSTART far in the future so pre-fix range queries in this file never iterate toward it.
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-subdaily-1@eigen\r\nSUMMARY:SubDaily PUT\r\nDTSTART:20990101T090000Z\r\nDTEND:20990101T100000Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-subdaily-1.ics`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );
        // Untrusted ICS must not 500 the sync; the explosive rule is stripped and the event stored once.
        expect([201, 204]).toContain(putRes.status);

        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-subdaily-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body = await getRes.text();
        expect(body).toContain('SubDaily PUT');
        expect(body).not.toContain('SECONDLY');
    });
});
