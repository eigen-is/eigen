import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { handleDeleteCalendar } from '../../lib/caldav/proppatch';
import { REPORT_DATA_BUDGET_BYTES } from '../../lib/caldav/report';
import { Calendar } from '../../lib/calendar/calendar';
import { EVENT_MAX_BYTES } from '../../lib/calendar/resource-store';
import { ApiError } from '../../lib/core';
import { getHome } from '../../lib/home/get-home';
import { basicAuth, davRequest } from '../dav-test-helpers';
import { app, getTestContext } from '../setup';

describe('CalDAV', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let userId: string;
    let defaultCalendarId: string;

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

    // Eigen stamps every stored resource with its own lines, so a PUT hands back no validator (RFC 4791
    // § 5.3.4): the etag of the bytes the server kept comes from reading them.
    async function etagOf(uri: string): Promise<string> {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(200);
        return res.headers.get('ETag')!;
    }

    const putIcs = (uri: string, body: string, headers: Record<string, string> = {}, calendarId?: string) =>
        davRequest('PUT', `/dav/calendars/${userId}/${calendarId ?? defaultCalendarId}/${uri}`, {
            email: ctx.alice.user.email,
            headers: { 'Content-Type': 'text/calendar', ...headers },
            body,
        });

    const getIcs = async (uri: string): Promise<string> => {
        const res = await davRequest('GET', `/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
            email: ctx.alice.user.email,
        });
        expect(res.status).toBe(200);
        return res.text();
    };

    const report = (body: string, calendarId?: string) =>
        davRequest('REPORT', `/dav/calendars/${userId}/${calendarId ?? defaultCalendarId}/`, {
            email: ctx.alice.user.email,
            headers: { 'Content-Type': 'application/xml' },
            body,
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

    // Apple clients derive per-source editability from these props; without them every edit of an
    // existing resource is saved as a NEW one (the CardDAV duplicate-on-edit class, fixed 2026-08-18).
    test('calendar home and collections advertise write privileges and ownership', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        const xml = await res.text();
        expect(xml).toContain('<D:current-user-privilege-set><D:privilege><D:all/></D:privilege>');
        expect(xml).toContain(`<D:owner><D:href>/dav/principals/${userId}/</D:href></D:owner>`);
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
        // A body the server re-stamped before storing carries no validator back.
        expect(putRes.headers.get('ETag')).toBeNull();

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

    // --- RFC 7232 If-Match / If-None-Match on the write seam (mirrors the CardDAV precondition tests) ---

    test('If-Match: * succeeds against an existing event for PUT and DELETE', async () => {
        const uid = 'caldav-ifmatch-star@eigen';
        const uri = 'caldav-ifmatch-star.ics';
        const ics = (summary: string) =>
            `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20260701T100000Z\r\nDTEND:20260701T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

        const create = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics('Star Create'),
            }),
        );
        expect(create.status).toBe(201);

        const update = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-Match': '*',
                },
                body: ics('Star Update'),
            }),
        );
        expect(update.status).toBe(204);

        const del = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'If-Match': '*' },
            }),
        );
        expect(del.status).toBe(204);
    });

    test('If-Match with an etag on a missing event is 412 and creates nothing', async () => {
        const uri = 'caldav-ifmatch-missing.ics';
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-ifmatch-missing@eigen\r\nSUMMARY:Should Not Exist\r\nDTSTART:20260702T100000Z\r\nDTEND:20260702T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-Match': '"nonexistent-etag"',
                },
                body: ics,
            }),
        );
        expect(res.status).toBe(412);

        const get = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(get.status).toBe(404);
    });

    test('If-Match with a stale etag is 412 and leaves the stored event untouched', async () => {
        const uid = 'caldav-ifmatch-stale@eigen';
        const uri = 'caldav-ifmatch-stale.ics';
        const ics = (summary: string) =>
            `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20260703T100000Z\r\nDTEND:20260703T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

        const create = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics('Original'),
            }),
        );
        expect(create.status).toBe(201);
        const etag = await etagOf(uri);

        const stale = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-Match': '"stale-etag"',
                },
                body: ics('Overwritten'),
            }),
        );
        expect(stale.status).toBe(412);

        const get = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(get.status).toBe(200);
        const body = await get.text();
        expect(body).toContain('Original');
        expect(body).not.toContain('Overwritten');
        expect(get.headers.get('ETag')).toBe(etag);
    });

    test('a non-star If-None-Match matching the current etag is 412', async () => {
        const uid = 'caldav-inm-current@eigen';
        const uri = 'caldav-inm-current.ics';
        const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:INM Current\r\nDTSTART:20260704T100000Z\r\nDTEND:20260704T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

        const create = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics,
            }),
        );
        expect(create.status).toBe(201);
        const etag = await etagOf(uri);

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': etag!,
                },
                body: ics,
            }),
        );
        expect(res.status).toBe(412);
    });

    test('a comma-list If-Match containing the current etag succeeds', async () => {
        const uid = 'caldav-ifmatch-list@eigen';
        const uri = 'caldav-ifmatch-list.ics';
        const ics = (summary: string) =>
            `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:20260705T100000Z\r\nDTEND:20260705T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

        const create = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-None-Match': '*',
                },
                body: ics('List Create'),
            }),
        );
        expect(create.status).toBe(201);
        const etag = await etagOf(uri);

        const update = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: {
                    Authorization: basicAuth(ctx.alice.user.email),
                    'Content-Type': 'text/calendar',
                    'If-Match': `"deadbeef", ${etag}`,
                },
                body: ics('List Update'),
            }),
        );
        expect(update.status).toBe(204);
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
        const originalEtag = await etagOf('caldav-recur-1.ics');

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

        // GET the event — the canceled exception round-trips as EXDATE on the master, not as a
        // STATUS:CANCELLED override VEVENT (clients like Thunderbird drop those from their next PUT).
        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-recur-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body = await getRes.text();
        expect(body).toContain('RRULE:FREQ=DAILY');
        // A PUT is a full-resource replace: the cancelled override the client wrote is stored as it
        // wrote it, and the occurrence it cancels drops out of the expansion all the same.
        expect(body).toContain('RECURRENCE-ID:20260403T090000Z');
        expect(body).toContain('STATUS:CANCELLED');

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

    test('REPORT with an unknown root element is 400', async () => {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<D:not-a-real-report xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:not-a-real-report>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(400);
    });

    test('REPORT with an empty body is 400, never a full etag dump', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: '',
            }),
        );
        expect(res.status).toBe(400);
    });

    test('sync-collection rejects a malformed or legacy-format token with 403 valid-sync-token', async () => {
        // The legacy `urn:eigen:sync/N` slash form is no longer accepted — an unrecognised token is simply invalid.
        for (const token of ['urn:eigen:sync/5', 'urn:eigen:sync:abc', 'nonsense']) {
            const body = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${token}</D:sync-token>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
            const res = await app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                    method: 'REPORT',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                    body,
                }),
            );
            expect(res.status).toBe(403);
            expect(await res.text()).toContain('valid-sync-token');
        }
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
        const etag1 = await etagOf('etag-stable.ics');

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
        const etag2 = await etagOf('etag-stable.ics');

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

    // RFC 4791 § 9.9: the filter matches the recurrence set with its overrides applied, so the resource of a
    // moved occurrence answers in the window it landed in and not in the one it left.
    test('REPORT calendar-query time-range follows an occurrence moved to another week', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-moved-1@eigen',
            'SUMMARY:Relocating Series',
            'DTSTART:20260601T090000Z',
            'DTEND:20260601T100000Z',
            'RRULE:FREQ=WEEKLY;COUNT=4',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:caldav-moved-1@eigen',
            'RECURRENCE-ID:20260608T090000Z',
            'SUMMARY:Relocated Occurrence',
            'DTSTART:20260710T090000Z',
            'DTEND:20260710T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        expect((await putIcs('caldav-moved-1.ics', ics)).status).toBe(201);

        const query = async (start: string, end: string) => {
            const res = await app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                    method: 'REPORT',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                    body: `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
                }),
            );
            expect(res.status).toBe(207);
            return res.text();
        };

        expect(await query('20260710T000000Z', '20260711T000000Z')).toContain('caldav-moved-1.ics');
        expect(await query('20260608T000000Z', '20260609T000000Z')).not.toContain('caldav-moved-1.ics');
        expect(await query('20260601T000000Z', '20260602T000000Z')).toContain('caldav-moved-1.ics');
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
        // Untrusted ICS must not 500 the sync; the file keeps what the client wrote and the index
        // degrades the explosive rule to a single event instead of expanding it.
        expect([201, 204]).toContain(putRes.status);

        const getRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-subdaily-1.ics`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        const body = await getRes.text();
        expect(body).toContain('SubDaily PUT');
        // The stored resource is the client's, rule included — the index is what drops it.
        expect(body).toContain('RRULE:FREQ=SECONDLY');
        const stored = await (await getHome(userId)).calendar.getEventByUri(defaultCalendarId, 'caldav-subdaily-1.ics');
        expect(stored!.rrule).toBeNull();
    });

    test('a REPORT body over 1 MiB is 413 before parsing', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: 'a'.repeat(1_048_577),
            }),
        );
        expect(res.status).toBe(413);
    });

    test('an oversize PUT is 413 max-resource-size before parsing', async () => {
        const prefix =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-oversize@eigen\r\nSUMMARY:Big\r\nDTSTART:20260801T090000Z\r\nDTEND:20260801T100000Z\r\nDESCRIPTION:';
        const suffix = '\r\nEND:VEVENT\r\nEND:VCALENDAR';
        const pad = EVENT_MAX_BYTES + 1 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-oversize.ics`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: prefix + 'a'.repeat(pad) + suffix,
            }),
        );
        expect(res.status).toBe(413);
        expect(await res.text()).toContain('max-resource-size');
    });

    test('a PUT whose resource name exceeds the length cap is 400', async () => {
        const longUri = `${'x'.repeat(300)}.ics`;
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-longuri@eigen\r\nSUMMARY:Long\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${longUri}`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );
        expect(res.status).toBe(400);
    });

    // A previewed or imported file drops the one VEVENT it cannot read and keeps the rest; one CalDAV
    // resource is one series a client just wrote, so a VEVENT of it the parser refuses breaks the resource.
    test('a PUT holding a VEVENT the parser cannot read is refused with its precondition', async () => {
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-unreadable@eigen',
            'SUMMARY:Readable',
            'DTSTART:20260901T090000Z',
            'DTEND:20260901T100000Z',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:caldav-unreadable@eigen',
            'RECURRENCE-ID:20260908T090000Z',
            'SUMMARY:No start at all',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-unreadable.ics`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );

        expect(res.status).toBe(403);
        expect(await res.text()).toContain('valid-calendar-object-resource');
    });

    test('calendar-multiget with more than 500 hrefs is 400', async () => {
        const hrefs = Array.from(
            { length: 501 },
            (_, i) => `<D:href>/dav/calendars/${userId}/${defaultCalendarId}/caldav-bulk-${i}.ics</D:href>`,
        ).join('\n');
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/></D:prop>
  ${hrefs}
</C:calendar-multiget>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(400);
    });

    test('calendar-multiget collapses duplicate hrefs (present and missing) to one row each', async () => {
        const present = 'caldav-multiget-dup.ics';
        const missing = 'caldav-multiget-missing.ics';
        const href = (uri: string) => `/dav/calendars/${userId}/${defaultCalendarId}/${uri}`;
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-multiget-dup@eigen\r\nSUMMARY:Dup Test\r\nDTSTART:20260701T090000Z\r\nDTEND:20260701T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
        await app.handle(
            new Request(`http://localhost${href(present)}`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );

        // The same two resources listed four ways: the present one twice, the missing one twice.
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <D:href>${href(present)}</D:href>
  <D:href>${href(present)}</D:href>
  <D:href>${href(missing)}</D:href>
  <D:href>${href(missing)}</D:href>
</C:calendar-multiget>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        // Two distinct resources → exactly two rows, and the missing one 404s exactly once (the dedupe nit).
        expect((xml.match(/<D:response>/g) ?? []).length).toBe(2);
        expect((xml.match(/404 Not Found/g) ?? []).length).toBe(1);
        expect(xml).toContain('Dup Test');
    });

    test('PROPFIND a single event returns its own href and quoted etag', async () => {
        const uri = 'caldav-propfind-one.ics';
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-propfind-one@eigen\r\nSUMMARY:One Event\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
        const putRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );
        expect(putRes.status).toBe(201);
        const etag = await etagOf(uri);

        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${uri}`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        // The event's own href, not the collection's, and its quoted etag matching the PUT response.
        expect(xml).toContain(`/dav/calendars/${userId}/${defaultCalendarId}/${uri}`);
        expect(xml).toContain(`<D:getetag>${etag}</D:getetag>`);
    });

    test('PROPFIND a missing event uri is 404', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/caldav-propfind-nope.ics`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(404);
    });

    describe('PROPFIND honors the requested prop list', () => {
        // A seeded event whose href/etag every prop-list case below reads.
        let propUri: string;
        let propEtag: string;

        const propfindEvent = (body: string, headers: Record<string, string> = {}) =>
            app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${propUri}`, {
                    method: 'PROPFIND',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0', ...headers },
                    body,
                }),
            );

        beforeAll(async () => {
            propUri = 'caldav-proplist.ics';
            const ics =
                'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-proplist@eigen\r\nSUMMARY:Prop List\r\nDTSTART:20261201T090000Z\r\nDTEND:20261201T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
            const putRes = await app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${propUri}`, {
                    method: 'PUT',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                    body: ics,
                }),
            );
            expect(putRes.status).toBe(201);
            propEtag = await etagOf(propUri);
        });

        test('a body requesting only getetag drops getcontenttype from the member row', async () => {
            const res = await propfindEvent(
                `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`,
            );
            expect(res.status).toBe(207);
            const xml = await res.text();
            expect(xml).toContain(`<D:getetag>${propEtag}</D:getetag>`);
            expect(xml).not.toContain('getcontenttype');
            expect(xml).not.toContain('resourcetype');
        });

        test('getetag + resourcetype + an unknown prop split into 200 and 404 propstats', async () => {
            const res = await propfindEvent(
                `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:example:x"><D:prop><D:getetag/><D:resourcetype/><X:frobnicate/></D:prop></D:propfind>`,
            );
            expect(res.status).toBe(207);
            const xml = await res.text();
            expect(xml).toContain(`<D:getetag>${propEtag}</D:getetag>`);
            // Member rows carry the empty resourcetype discriminator, not the collection form.
            expect(xml).toContain('<D:resourcetype/>');
            // The unknown prop is echoed in its own namespace inside a 404 propstat.
            expect(xml).toContain('404 Not Found');
            expect(xml).toContain('frobnicate');
            expect(xml).toContain('urn:example:x');
        });

        test('Brief:t suppresses the 404 propstat', async () => {
            const res = await propfindEvent(
                `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:example:x"><D:prop><D:getetag/><X:frobnicate/></D:prop></D:propfind>`,
                { Brief: 't' },
            );
            const xml = await res.text();
            expect(xml).toContain(`<D:getetag>${propEtag}</D:getetag>`);
            expect(xml).not.toContain('404 Not Found');
        });

        test('Prefer:return=minimal suppresses the 404 propstat', async () => {
            const res = await propfindEvent(
                `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:X="urn:example:x"><D:prop><D:getetag/><X:frobnicate/></D:prop></D:propfind>`,
                { Prefer: 'return=minimal' },
            );
            const xml = await res.text();
            expect(xml).toContain(`<D:getetag>${propEtag}</D:getetag>`);
            expect(xml).not.toContain('404 Not Found');
        });

        test('a bodyless PROPFIND still serves allprop, now with the member resourcetype', async () => {
            const res = await propfindEvent('');
            expect(res.status).toBe(207);
            const xml = await res.text();
            expect(xml).toContain(`<D:getetag>${propEtag}</D:getetag>`);
            expect(xml).toContain('getcontenttype');
            expect(xml).toContain('<D:resourcetype/>');
        });

        test('a collection row honors a subset request', async () => {
            const res = await app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                    method: 'PROPFIND',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
                    body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>`,
                }),
            );
            expect(res.status).toBe(207);
            const xml = await res.text();
            expect(xml).toContain('<D:displayname>');
            // The unrequested collection props stay out.
            expect(xml).not.toContain('getctag');
            expect(xml).not.toContain('supported-report-set');
        });
    });

    test('a %40-encoded @ in a resource name round-trips through PUT, GET, PROPFIND and is emitted raw', async () => {
        // The client may PUT the @ percent-encoded; inbound decodes a%40b.ics to the stored uri a@b.ics. @ is
        // pchar-legal (RFC 3986), so every emitted href/Location carries it raw — never re-encoded back to %40.
        const requestHref = `/dav/calendars/${userId}/${defaultCalendarId}/a%40b.ics`;
        const emittedHref = `/dav/calendars/${userId}/${defaultCalendarId}/a@b.ics`;
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-encoded@eigen',
            'SUMMARY:Encoded URI Event',
            'DTSTART:20261101T090000Z',
            'DTEND:20261101T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        const putRes = await app.handle(
            new Request(`http://localhost${requestHref}`, {
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
        expect(putRes.headers.get('Location')).toBe(emittedHref);

        const getRes = await app.handle(
            new Request(`http://localhost${requestHref}`, {
                method: 'GET',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(getRes.status).toBe(200);
        expect(await getRes.text()).toContain('Encoded URI Event');
        const etag = getRes.headers.get('ETag');
        expect(etag).toBeTruthy();

        const propRes = await app.handle(
            new Request(`http://localhost${requestHref}`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(propRes.status).toBe(207);
        const propXml = await propRes.text();
        // The emitted href carries the raw @, never the %40-encoded form, and its etag matches the PUT.
        expect(propXml).toContain(emittedHref);
        expect(propXml).not.toContain('a%40b.ics');
        expect(propXml).toContain(`<D:getetag>${etag}</D:getetag>`);
    });

    test('REPORT multiget and sync-collection resolve a %40-encoded href and emit the @ raw', async () => {
        // c%40d.ics decodes to c@d.ics: multiget must decode the inbound href before matching, and both surfaces
        // emit the @ raw (pchar-legal, RFC 3986) — never re-encoded back to the %40 form.
        const requestHref = `/dav/calendars/${userId}/${defaultCalendarId}/c%40d.ics`;
        const emittedHref = `/dav/calendars/${userId}/${defaultCalendarId}/c@d.ics`;
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-encoded-report@eigen',
            'SUMMARY:Encoded Report Event',
            'DTSTART:20261102T090000Z',
            'DTEND:20261102T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');
        const putRes = await app.handle(
            new Request(`http://localhost${requestHref}`, {
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

        const multigetBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <D:href>${requestHref}</D:href>
</C:calendar-multiget>`;
        const multigetRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: multigetBody,
            }),
        );
        expect(multigetRes.status).toBe(207);
        const multigetXml = await multigetRes.text();
        expect(multigetXml).toContain('Encoded Report Event');
        expect(multigetXml).toContain(emittedHref);
        expect(multigetXml).not.toContain('c%40d.ics');

        const syncBody = `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token/>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
        const syncRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: syncBody,
            }),
        );
        expect(syncRes.status).toBe(207);
        const syncXml = await syncRes.text();
        expect(syncXml).toContain(emittedHref);
        expect(syncXml).not.toContain('c%40d.ics');
    });

    test('MKCALENDAR at a client-chosen URL creates that exact calendar, PROPFIND finds it, home lists it', async () => {
        const calId = 'client-chosen-cal';
        const mkBody = `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">
  <D:set><D:prop>
    <D:displayname>My New Calendar</D:displayname>
    <ICAL:calendar-color>#ff0000</ICAL:calendar-color>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>`;
        const mkRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: mkBody,
            }),
        );
        expect(mkRes.status).toBe(201);
        expect(mkRes.headers.get('Location')).toBe(`/dav/calendars/${userId}/${calId}/`);

        // PROPFIND the exact client-chosen URL resolves and carries the displayname + color the client set.
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(propRes.status).toBe(207);
        const propXml = await propRes.text();
        expect(propXml).toContain('My New Calendar');
        expect(propXml).toContain('#ff0000');

        // And it appears in the calendar-home listing under the very same href.
        const homeRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        expect(await homeRes.text()).toContain(`/dav/calendars/${userId}/${calId}/`);
    });

    test('a duplicate MKCALENDAR to the same URL is 405 and leaves the existing calendar untouched', async () => {
        const calId = 'dup-cal';
        const mk = (body: string) =>
            app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                    method: 'MKCALENDAR',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                    body,
                }),
            );
        expect((await mk('')).status).toBe(201);
        const usurper = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Usurper</D:displayname></D:prop></D:set></C:mkcalendar>`;
        expect((await mk(usurper)).status).toBe(405);
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        const xml = await propRes.text();
        expect(xml).toContain(`<D:displayname>${calId}</D:displayname>`);
        expect(xml).not.toContain('Usurper');
    });

    test('MKCALENDAR without a displayname names the calendar after the URL segment', async () => {
        const calId = 'unnamed-cal';
        const body = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(201);
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(await propRes.text()).toContain(`<D:displayname>${calId}</D:displayname>`);
    });

    test('MKCALENDAR parses displayname and calendar-color given with element attributes (#text shape)', async () => {
        const calId = 'attr-shape-cal';
        // An xml:lang attribute makes fast-xml-parser wrap the value as { '@_...': ..., '#text': ... }.
        const body = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname xml:lang="en">Localized Name</D:displayname><ICAL:calendar-color symbolic-color="custom">#00ff00</ICAL:calendar-color></D:prop></D:set></C:mkcalendar>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(201);
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        const xml = await propRes.text();
        expect(xml).toContain('Localized Name');
        expect(xml).toContain('#00ff00');
    });

    test('MKCALENDAR keeps a purely numeric displayname (fxp coerces it to a number)', async () => {
        const calId = 'numeric-name-cal';
        const body = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>2026</D:displayname></D:prop></D:set></C:mkcalendar>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(201);
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(await propRes.text()).toContain('<D:displayname>2026</D:displayname>');
    });

    test('MKCALENDAR with an empty <displayname/> falls back to the URL segment', async () => {
        const calId = 'empty-name-cal';
        const body = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname/></D:prop></D:set></C:mkcalendar>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body,
            }),
        );
        expect(res.status).toBe(201);
        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(await propRes.text()).toContain(`<D:displayname>${calId}</D:displayname>`);
    });

    test('DELETE on a client-created calendar removes it, and PROPFIND no longer lists it', async () => {
        const calId = 'doomed-cal';
        const mkRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: '',
            }),
        );
        expect(mkRes.status).toBe(201);

        const delRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(delRes.status).toBe(204);

        const homeRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        expect(await homeRes.text()).not.toContain(`/dav/calendars/${userId}/${calId}/`);

        const propRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${calId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(propRes.status).toBe(404);
    });

    test('DELETE on an unknown calendar URL is 404', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/no-such-cal/`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(404);
    });

    test('DELETE on the default calendar is refused and leaves it in place', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'DELETE',
                headers: { Authorization: basicAuth(ctx.alice.user.email) },
            }),
        );
        expect(res.status).toBe(403);

        const homeRes = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '1' },
            }),
        );
        expect(await homeRes.text()).toContain(`/dav/calendars/${userId}/${defaultCalendarId}/`);
    });

    test('a delete failure that is not the default-calendar refusal keeps its own status', async () => {
        // The relay leg of deleteCalendar (a shared calendar's un-share) can fail with any status;
        // renaming those to 403 would tell the client the calendar is protected.
        const home = await getHome(userId);
        const spy = spyOn(Calendar.prototype, 'deleteCalendar').mockRejectedValue(
            new ApiError(502, 'Home unreachable'),
        );
        const deleting = handleDeleteCalendar(home.calendar, 'shared-cal');
        await expect(deleting).rejects.toMatchObject({ status: 502, message: 'Home unreachable' });
        spy.mockRestore();
    });

    // The props that fixed the macOS duplicate-on-edit class (2026-08-18) — a named request must serve them.
    test('a named PROPFIND requesting current-user-privilege-set and owner returns both', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
                body: `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-privilege-set/><D:owner/></D:prop></D:propfind>`,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('<D:current-user-privilege-set>');
        expect(xml).toContain('<D:all/>');
        expect(xml).toContain(`<D:owner><D:href>/dav/principals/${userId}/</D:href></D:owner>`);
    });

    test('a malformed PROPFIND body degrades to allprop', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
                body: `<D:propfind xmlns:D="DAV:><D:prop><D:getetag/></D:prop></D:propfind>`,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        expect(xml).toContain('getctag');
        expect(xml).toContain('supported-report-set');
    });

    test('the calendar collection advertises the resource ceiling its PUT enforces', async () => {
        const propfindCalendar = (body: string) =>
            app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                    method: 'PROPFIND',
                    headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
                    body,
                }),
            );

        const all = await propfindCalendar('');
        expect(all.status).toBe(207);
        expect(await all.text()).toContain('<C:max-resource-size>5242880</C:max-resource-size>');

        // RFC 4791 § 5.2.5: a client asks for it by name to size a PUT before sending it.
        const named = await propfindCalendar(
            `<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:max-resource-size/></D:prop></D:propfind>`,
        );
        expect(named.status).toBe(207);
        const xml = await named.text();
        expect(xml).toContain('<C:max-resource-size>5242880</C:max-resource-size>');
        expect(xml).not.toContain('404 Not Found');
    });

    test('MKCALENDAR with an invalid id segment (leading dot) is 400', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/.hidden/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: '',
            }),
        );
        expect(res.status).toBe(400);
    });

    test('MKCALENDAR with a malformed percent-escape in the URL is 400', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/%zz/`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: '',
            }),
        );
        expect(res.status).toBe(400);
    });

    test('MKCALENDAR targeting a resource path (two segments) is 400', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/some-cal/nested.ics`, {
                method: 'MKCALENDAR',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: '',
            }),
        );
        expect(res.status).toBe(400);
    });

    test('PROPFIND with a malformed percent-escape in the URL is 400', async () => {
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/%zz.ics`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth(ctx.alice.user.email), Depth: '0' },
            }),
        );
        expect(res.status).toBe(400);
    });

    test('calendar-multiget emits a 404 row for malformed and out-of-collection hrefs', async () => {
        const present = 'caldav-multiget-mixed.ics';
        const ics =
            'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:caldav-multiget-mixed@eigen\r\nSUMMARY:Mixed Row Test\r\nDTSTART:20260801T090000Z\r\nDTEND:20260801T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
        await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${present}`, {
                method: 'PUT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'text/calendar' },
                body: ics,
            }),
        );
        const presentHref = `/dav/calendars/${userId}/${defaultCalendarId}/${present}`;
        const malformedHref = `/dav/calendars/${userId}/${defaultCalendarId}/%zz.ics`;
        const outOfCollectionHref = `/dav/calendars/${userId}/some-other-calendar/x.ics`;
        const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <D:href>${presentHref}</D:href>
  <D:href>${malformedHref}</D:href>
  <D:href>${outOfCollectionHref}</D:href>
</C:calendar-multiget>`;
        const res = await app.handle(
            new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/`, {
                method: 'REPORT',
                headers: { Authorization: basicAuth(ctx.alice.user.email), 'Content-Type': 'application/xml' },
                body: reportBody,
            }),
        );
        expect(res.status).toBe(207);
        const xml = await res.text();
        // One row per href: the present one 200, the two bad ones 404 echoing the original href.
        expect((xml.match(/<D:response>/g) ?? []).length).toBe(3);
        expect((xml.match(/404 Not Found/g) ?? []).length).toBe(2);
        expect(xml).toContain('Mixed Row Test');
        expect(xml).toContain(malformedHref);
        expect(xml).toContain(outOfCollectionHref);
    });

    test('a resource name a file system cannot hold is refused, never rewritten', async () => {
        // A resource name is a file name now, so it takes the same segment rule a card does: a space, a
        // traversal, a missing suffix and an over-long name are all 400s rather than a silent rewrite.
        const ics = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'BEGIN:VEVENT',
            'UID:caldav-unsafe@eigen',
            'SUMMARY:Unsafe name',
            'DTSTART:20261103T090000Z',
            'DTEND:20261103T100000Z',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n');

        for (const name of ['a%20b.ics', '..%2Fescape.ics', 'no-suffix', `${'x'.repeat(300)}.ics`, 'calendar.db']) {
            const res = await app.handle(
                new Request(`http://localhost/dav/calendars/${userId}/${defaultCalendarId}/${name}`, {
                    method: 'PUT',
                    headers: {
                        Authorization: basicAuth(ctx.alice.user.email),
                        'Content-Type': 'text/calendar',
                        'If-None-Match': '*',
                    },
                    body: ics,
                }),
            );
            expect([400, 404]).toContain(res.status);
        }
    });

    // Whether a PUT may replace a resource is decided by the organizer stamp the server itself wrote, which
    // a client cannot forge — never by the ORGANIZER address, which a client picks freely.
    describe('the linked-copy restriction follows the server stamp', () => {
        const withOrganizer = (uid: string, summary: string, organizer: string, extra: string[] = []) =>
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'BEGIN:VEVENT',
                `UID:${uid}`,
                `SUMMARY:${summary}`,
                'DTSTART:20261110T090000Z',
                'DTEND:20261110T100000Z',
                `ORGANIZER:mailto:${organizer}`,
                ...extra,
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n');

        test("an event the client organized in somebody else's name stays the client's to edit", async () => {
            const uri = 'caldav-foreign-organizer.ics';
            const uid = 'caldav-foreign-organizer@eigen';
            expect((await putIcs(uri, withOrganizer(uid, 'Booked by an assistant', 'boss@example.com'))).status).toBe(
                201,
            );

            // The address is the client's to change, and the change has to stick.
            expect((await putIcs(uri, withOrganizer(uid, 'Mine now', ctx.alice.user.email))).status).toBe(204);
            expect(await getIcs(uri)).toContain(`ORGANIZER:mailto:${ctx.alice.user.email}`);
            expect(await getIcs(uri)).toContain('SUMMARY:Mine now');

            expect((await putIcs(uri, withOrganizer(uid, 'Edited again', ctx.alice.user.email))).status).toBe(204);
            expect(await getIcs(uri)).toContain('SUMMARY:Edited again');
        });

        test('a forged organizer stamp does not survive the PUT that carried it', async () => {
            const uri = 'caldav-forged-stamp.ics';
            const uid = 'caldav-forged-stamp@eigen';
            const forged = ['X-EIGEN-ORGANIZER-EVENT:forged-event', 'X-EIGEN-ORGANIZER-USER:forged-user'];
            expect((await putIcs(uri, withOrganizer(uid, 'Forged', 'boss@example.com', forged))).status).toBe(201);
            expect(await getIcs(uri)).not.toContain('forged-event');

            expect((await putIcs(uri, withOrganizer(uid, 'Still mine', 'boss@example.com', forged))).status).toBe(204);
            expect(await getIcs(uri)).toContain('SUMMARY:Still mine');
        });

        test("a copy of somebody else's event keeps its fields and takes only the body's alarms", async () => {
            const uid = 'caldav-linked-copy@external.com';
            const home = await getHome(userId);
            await home.calendar.receiveInvitation({
                uid,
                title: 'Quarterly review',
                description: null,
                location: null,
                startTime: new Date('2026-11-12T09:00:00Z'),
                endTime: new Date('2026-11-12T10:00:00Z'),
                allDay: false,
                rrule: null,
                timezone: null,
                status: 'confirmed',
                sequence: 0,
                data: {
                    organizer: { userId: 'external_boss@example.com', email: 'boss@example.com', name: 'Boss' },
                    organizerEventId: uid,
                },
                createByUserId: 'external_boss@example.com',
                organizerEventId: uid,
                organizerUserId: 'external_boss@example.com',
            });
            const stored = (await home.calendar.listResources(defaultCalendarId)).find((r) => r.uid === uid)!;
            expect(stored).toBeDefined();

            const res = await putIcs(
                stored.uri,
                withOrganizer(uid, 'Renamed by the attendee', ctx.alice.user.email, [
                    'BEGIN:VALARM',
                    'ACTION:DISPLAY',
                    'DESCRIPTION:Reminder',
                    'TRIGGER:-PT15M',
                    'END:VALARM',
                ]),
            );
            expect(res.status).toBe(204);
            // A body the server did not store has no validator to hand back (RFC 4791 § 5.3.4).
            expect(res.headers.get('ETag')).toBeNull();

            const served = await getIcs(stored.uri);
            expect(served).toContain('SUMMARY:Quarterly review');
            expect(served).toContain('ORGANIZER;CN=Boss:mailto:boss@example.com');
            expect(served).toContain(`X-EIGEN-ORGANIZER-EVENT:${uid}`);
            expect(served).toContain('TRIGGER:-PT15M');
        });
    });

    describe('the REPORT and PUT protocol rules', () => {
        const ics = (uid: string, summary: string, extra: string[] = []) =>
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'BEGIN:VEVENT',
                `UID:${uid}`,
                `SUMMARY:${summary}`,
                'DTSTART:20261201T090000Z',
                'DTEND:20261201T100000Z',
                ...extra,
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n');

        const query = (filter: string, calendarId?: string) =>
            report(
                `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>${filter}</C:filter>
</C:calendar-query>`,
                calendarId,
            );

        const multiget = (uris: string[]) =>
            report(
                `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  ${uris.map((uri) => `<D:href>/dav/calendars/${userId}/${defaultCalendarId}/${uri}</D:href>`).join('\n  ')}
</C:calendar-multiget>`,
            );

        test('a calendar-data REPORT serves up to its byte budget and lists the rest by etag alone', async () => {
            const home = await getHome(userId);
            const bulk = await home.calendar.createCalendar({ name: 'Budget', color: '#2563eb' });
            const padding = 'x'.repeat(4_000_000);
            const count = Math.ceil(REPORT_DATA_BUDGET_BYTES / 4_000_000) + 1;
            for (let i = 0; i < count; i++) {
                const res = await putIcs(
                    `bulk-${i}.ics`,
                    ics(`caldav-bulk-${i}@eigen`, 'Bulk', [`DESCRIPTION:${padding}`]),
                    {},
                    bulk.id,
                );
                expect(res.status).toBe(201);
            }

            const res = await query(
                '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter>',
                bulk.id,
            );
            expect(res.status).toBe(207);
            const xml = await res.text();
            // Every resource is still named; the ones past the budget carry their data as a 404 prop, so a
            // client sees them and fetches them by multiget instead of losing them. Both halves are
            // asserted: a budget that serves nothing, or spends nothing, would answer this query too.
            expect((xml.match(/<D:response>/g) ?? []).length).toBe(count);
            const served = (xml.match(/<C:calendar-data>/g) ?? []).length;
            const withheld = (xml.match(/<C:calendar-data\/>/g) ?? []).length;
            expect(served).toBeGreaterThan(0);
            expect(withheld).toBeGreaterThan(0);
            expect(served + withheld).toBe(count);
            expect(xml.length).toBeLessThan(REPORT_DATA_BUDGET_BYTES);
        }, 120_000);

        test('a row whose file vanished is a 404 row, never a 200 without its data', async () => {
            const uri = 'caldav-vanished.ics';
            expect((await putIcs(uri, ics('caldav-vanished@eigen', 'Vanished Row'))).status).toBe(201);
            const home = await getHome(userId);
            rmSync(join(home.homeDir, 'eigen.calendar', 'calendars', defaultCalendarId, uri));

            const xml = await (await multiget([uri])).text();
            expect(xml).toContain('404 Not Found');
            expect(xml).not.toContain('Vanished Row');
        });

        test('a PUT into a calendar that does not exist is 409 and creates nothing', async () => {
            const missing = 'caldav-no-such-calendar';
            const res = await putIcs('anywhere.ics', ics('caldav-no-collection@eigen', 'Nowhere'), {}, missing);
            expect(res.status).toBe(409);
            const home = await getHome(userId);
            expect(existsSync(join(home.homeDir, 'eigen.calendar', 'calendars', missing))).toBe(false);
        });

        test('a comp-filter for a component Eigen does not store matches nothing', async () => {
            expect((await putIcs('caldav-comp-filter.ics', ics('caldav-comp-filter@eigen', 'Present'))).status).toBe(
                201,
            );
            const res = await query('<C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter>');
            expect(res.status).toBe(207);
            expect(await res.text()).not.toContain('<D:response>');
        });

        test('a VEVENT filter that says the component is not defined matches nothing', async () => {
            expect((await putIcs('caldav-not-defined.ics', ics('caldav-not-defined@eigen', 'Present'))).status).toBe(
                201,
            );
            const res = await query(
                '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:is-not-defined/></C:comp-filter></C:comp-filter>',
            );
            expect(res.status).toBe(207);
            expect(await res.text()).not.toContain('<D:response>');
        });

        test('a lookup by UID is answered, the text-match it carries ignored rather than refused', async () => {
            // python-caldav's event_by_uid, and Evolution's every query: RFC 4791 § 9.7 makes prop-filter
            // and text-match part of the mandatory grammar, so a 403 takes the whole collection with it.
            expect((await putIcs('caldav-by-uid.ics', ics('caldav-by-uid@eigen', 'By UID'))).status).toBe(201);
            const res = await query(
                '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match>caldav-by-uid@eigen</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter>',
            );
            expect(res.status).toBe(207);
            expect(await res.text()).toContain('By UID');
        });

        test('a multiget href folds to the stored resource the way a GET does', async () => {
            const stored = 'caldav-Case-Fold.ics';
            expect((await putIcs(stored, ics('caldav-case-fold@eigen', 'Case Fold'))).status).toBe(201);

            const xml = await (await multiget(['caldav-case-fold.ics'])).text();
            expect(xml).toContain('Case Fold');
            expect(xml).toContain(stored);
            expect(xml).not.toContain('404 Not Found');
        });

        test('a case-variant PUT rewrites the stored resource under its stored name', async () => {
            const stored = 'caldav-Case-Put.ics';
            expect((await putIcs(stored, ics('caldav-case-put@eigen', 'First'))).status).toBe(201);

            const res = await putIcs('CALDAV-CASE-PUT.ics', ics('caldav-case-put@eigen', 'Second'));
            expect(res.status).toBe(204);
            expect(res.headers.get('Location')).toBeNull();
            expect(await getIcs(stored)).toContain('SUMMARY:Second');

            const propfind = await davRequest('PROPFIND', `/dav/calendars/${userId}/${defaultCalendarId}/`, {
                email: ctx.alice.user.email,
                headers: { Depth: '1' },
            });
            const xml = await propfind.text();
            expect(xml).toContain(stored);
            expect(xml).not.toContain('CALDAV-CASE-PUT.ics');
        });

        test('an identical re-PUT changes nothing: no ctag bump, no sync row, an ETag back', async () => {
            const uri = 'caldav-noop-put.ics';
            expect((await putIcs(uri, ics('caldav-noop-put@eigen', 'Unchanged'))).status).toBe(201);
            const home = await getHome(userId);
            const before = (await home.calendar.getCollection(defaultCalendarId))!.ctag;
            const etag = await etagOf(uri);

            // The bytes the client just read back are the bytes it re-sends.
            const res = await putIcs(uri, await getIcs(uri));
            expect(res.status).toBe(204);
            expect(res.headers.get('ETag')).toBe(etag);
            expect((await home.calendar.getCollection(defaultCalendarId))!.ctag).toBe(before);
            expect(await home.calendar.getChangedResourcesSince(defaultCalendarId, before)).toHaveLength(0);
        });

        test('a body that breaks a CalDAV precondition says which one', async () => {
            const cases: [string, string, string][] = [
                [
                    'caldav-pre-component.ics',
                    [
                        'BEGIN:VCALENDAR',
                        'VERSION:2.0',
                        'BEGIN:VTODO',
                        'UID:caldav-pre-todo@eigen',
                        'END:VTODO',
                        'END:VCALENDAR',
                    ].join('\r\n'),
                    'supported-calendar-component',
                ],
                ['caldav-pre-data.ics', 'this is not iCalendar at all', 'valid-calendar-data'],
                [
                    'caldav-pre-uids.ics',
                    [
                        'BEGIN:VCALENDAR',
                        'VERSION:2.0',
                        'BEGIN:VEVENT',
                        'UID:caldav-pre-one@eigen',
                        'SUMMARY:One',
                        'DTSTART:20261201T090000Z',
                        'DTEND:20261201T100000Z',
                        'END:VEVENT',
                        'BEGIN:VEVENT',
                        'UID:caldav-pre-two@eigen',
                        'SUMMARY:Two',
                        'DTSTART:20261201T090000Z',
                        'DTEND:20261201T100000Z',
                        'END:VEVENT',
                        'END:VCALENDAR',
                    ].join('\r\n'),
                    'valid-calendar-object-resource',
                ],
                [
                    'caldav-pre-masters.ics',
                    [
                        'BEGIN:VCALENDAR',
                        'VERSION:2.0',
                        'BEGIN:VEVENT',
                        'UID:caldav-pre-masters@eigen',
                        'SUMMARY:First master',
                        'DTSTART:20261201T090000Z',
                        'DTEND:20261201T100000Z',
                        'END:VEVENT',
                        'BEGIN:VEVENT',
                        'UID:caldav-pre-masters@eigen',
                        'SUMMARY:Second master',
                        'DTSTART:20261202T090000Z',
                        'DTEND:20261202T100000Z',
                        'END:VEVENT',
                        'END:VCALENDAR',
                    ].join('\r\n'),
                    'valid-calendar-object-resource',
                ],
            ];

            for (const [uri, body, precondition] of cases) {
                const res = await putIcs(uri, body);
                expect(res.status).toBe(403);
                expect(await res.text()).toContain(precondition);
            }
        });
    });
});
