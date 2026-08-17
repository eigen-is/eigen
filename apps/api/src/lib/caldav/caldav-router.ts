import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { requireSelf } from '../core/access';
import { readBoundedBody } from '../core/http';
import { getHome } from '../home';
import { handleCalendarHomePropfind, handlePrincipalPropfind, handleRootPropfind } from './discovery';
import { handleCalendarPropfind, handleEventPropfind } from './propfind';
import { handleMkcalendar, handleProppatch } from './proppatch';
import { handleReport, REPORT_BODY_MAX_BYTES } from './report';
import { handleDelete, handleGet, handlePut } from './resource';

// The wildcard decodes to at most two segments — the calendar and an optional resource name. Resource names are
// client-chosen, so every segment is percent-decoded (the carddav twin's parseAddressbookPath); a malformed
// escape or a third segment is a client error, not a silent misroute.
type ParsedPath = { ok: true; calendarId: string | null; resourceUri: string | null } | { ok: false };

function parseDavPath(wildcard: string): ParsedPath {
    const parts = wildcard
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
    if (parts.length > 2) return { ok: false };
    const decoded: string[] = [];
    for (const part of parts) {
        try {
            decoded.push(decodeURIComponent(part));
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, calendarId: decoded[0] ?? null, resourceUri: decoded[1] ?? null };
}

export const caldavRouter = new Elysia({ name: 'caldav' })
    // PROPFIND /dav/ — discovery root
    .route('PROPFIND', '/dav', async ({ request }) => {
        const user = await authenticateBasic(request);
        return handleRootPropfind(user.id);
    })
    .route('PROPFIND', '/dav/', async ({ request }) => {
        const user = await authenticateBasic(request);
        return handleRootPropfind(user.id);
    })

    // PROPFIND /dav/principals/:ownerId/
    .route('PROPFIND', '/dav/principals/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        return handlePrincipalPropfind(params.ownerId);
    })
    .route('PROPFIND', '/dav/principals/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        return handlePrincipalPropfind(params.ownerId);
    })

    // PROPFIND /dav/calendars/:ownerId/ — calendar home
    .route('PROPFIND', '/dav/calendars/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        const calendars = home.calendar.getCalendars();
        const depth = request.headers.get('Depth') || '0';
        return handleCalendarHomePropfind(params.ownerId, calendars, depth);
    })

    // PROPFIND /dav/calendars/:ownerId/* — calendar collection or event listing
    .route('PROPFIND', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const depth = request.headers.get('Depth') || '0';

        if (!parsed.calendarId) {
            return handleCalendarHomePropfind(params.ownerId, home.calendar.getCalendars(), depth);
        }

        const calendar = home.calendar.getCalendarById(parsed.calendarId);
        if (!calendar) return new Response('Not Found', { status: 404 });

        // A resource segment is a single-event PROPFIND — the event's own href + etag, 404 if the uri is unknown.
        if (parsed.resourceUri) {
            const event = home.calendar.getEventByUri(parsed.calendarId, parsed.resourceUri);
            if (!event) return new Response('Not Found', { status: 404 });
            return handleEventPropfind(params.ownerId, parsed.calendarId, event.uri, event.etag);
        }

        const events = depth === '1' ? home.calendar.getRawEvents(parsed.calendarId) : [];
        return handleCalendarPropfind(params.ownerId, calendar, events, depth);
    })

    // GET .ics resource
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        // GET on collection URL (no resource) — return 200 so HEAD/GET checks pass
        if (!parsed.calendarId || !parsed.resourceUri) {
            return new Response('This is a CalDAV endpoint. Use a CalDAV client.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        const home = await getHome(params.ownerId);
        const event = home.calendar.getEventByUri(parsed.calendarId, parsed.resourceUri);
        if (!event) return new Response('Not Found', { status: 404 });

        const allEvents = home.calendar.getRawEventsByUid(parsed.calendarId, event.uid);
        return handleGet(event, allEvents);
    })

    // PUT .ics resource
    .put('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok || !parsed.calendarId || !parsed.resourceUri) {
            return new Response('Bad Request', { status: 400 });
        }

        const home = await getHome(params.ownerId);
        const body = await request.text();
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePut(
            home.calendar,
            params.ownerId,
            parsed.calendarId,
            parsed.resourceUri,
            body,
            ifMatch,
            ifNoneMatch,
            user.id,
        );
    })

    // DELETE .ics resource
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok || !parsed.calendarId || !parsed.resourceUri) {
            return new Response('Bad Request', { status: 400 });
        }

        const home = await getHome(params.ownerId);
        const ifMatch = request.headers.get('If-Match');
        return handleDelete(home.calendar, parsed.calendarId, parsed.resourceUri, ifMatch);
    })

    // REPORT — calendar-query, multiget, sync-collection
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok || !parsed.calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const calendarItem = home.calendar.getCalendarById(parsed.calendarId);
        if (!calendarItem) return new Response('Not Found', { status: 404 });

        const body = await readBoundedBody(request, REPORT_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleReport(home.calendar, parsed.calendarId, calendarItem, params.ownerId, body);
    })

    // MKCALENDAR
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        const body = await readBoundedBody(request, REPORT_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleMkcalendar(home.calendar, body);
    })

    // PROPPATCH
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseDavPath(params['*']);
        if (!parsed.ok || !parsed.calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await readBoundedBody(request, REPORT_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleProppatch(home.calendar, parsed.calendarId, params.ownerId, body);
    });
