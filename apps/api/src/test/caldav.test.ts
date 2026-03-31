import { beforeAll, describe, expect, test } from 'bun:test';
import { app } from '../app';
import { getTestContext } from './setup';

describe('CalDAV', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    let defaultCalendarId: string;

    const basicAuth = (email: string) => `Basic ${btoa(`${email}:anything`)}`;

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
});
