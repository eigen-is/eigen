import Elysia from 'elysia';
import { requireSelf } from '../core/access';
import { getHome } from '../home';
import { authenticateBasic } from './auth';
import { handleCalendarHomePropfind, handlePrincipalPropfind, handleRootPropfind } from './discovery';
import { handleCalendarPropfind } from './propfind';
import { handleMkcalendar, handleProppatch } from './proppatch';
import { handleReport } from './report';
import { handleDelete, handleGet, handlePut } from './resource';

function parseDavPath(wildcard: string): { calendarId?: string; resourceUri?: string } {
    const parts = wildcard
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
    return {
        calendarId: parts[0] || undefined,
        resourceUri: parts[1] || undefined,
    };
}

function logDav(method: string, path: string, status: number, detail?: string) {
    const line = `[CalDAV] ${method} ${path} → ${status}`;
    console.log(detail ? `${line}\n  ${detail}` : line);
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
        const { calendarId } = parseDavPath(params['*']);

        if (!calendarId) {
            const home = await getHome(params.ownerId);
            const calendars = home.calendar.getCalendars();
            const depth = request.headers.get('Depth') || '0';
            return handleCalendarHomePropfind(params.ownerId, calendars, depth);
        }

        const home = await getHome(params.ownerId);
        const calendar = home.calendar.getCalendarById(calendarId);
        if (!calendar) return new Response('Not Found', { status: 404 });
        const depth = request.headers.get('Depth') || '0';
        const events = depth === '1' ? home.calendar.getRawEvents(calendarId) : [];
        logDav(
            'PROPFIND',
            `/dav/calendars/.../${calendarId}/`,
            207,
            `Depth=${depth} ctag=${calendar.ctag} events=${events.length}`,
        );
        return handleCalendarPropfind(params.ownerId, calendar, events, depth);
    })

    // GET .ics resource
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const { calendarId, resourceUri } = parseDavPath(params['*']);

        // GET on collection URL (no resource) — return 200 so HEAD/GET checks pass
        if (!calendarId || !resourceUri) {
            return new Response('This is a CalDAV endpoint. Use a CalDAV client.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        const home = await getHome(params.ownerId);
        const event = home.calendar.getEventByUri(calendarId, resourceUri);
        if (!event) return new Response('Not Found', { status: 404 });

        const allEvents = home.calendar.getRawEvents(calendarId).filter((e) => e.uid === event.uid);
        return handleGet(event, allEvents);
    })

    // PUT .ics resource
    .put('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        const res = await handlePut(
            home.calendar,
            params.ownerId,
            calendarId,
            resourceUri,
            body,
            ifMatch,
            ifNoneMatch,
            user.id,
        );
        logDav(
            'PUT',
            `/dav/calendars/.../${resourceUri}`,
            res.status,
            `If-Match: ${ifMatch}, ETag: ${res.headers.get('ETag')}`,
        );
        return res;
    })

    // DELETE .ics resource
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const ifMatch = request.headers.get('If-Match');
        const res = handleDelete(home.calendar, calendarId, resourceUri, ifMatch);
        logDav('DELETE', `/dav/calendars/.../${resourceUri}`, res.status, `If-Match: ${ifMatch}`);
        return res;
    })

    // REPORT — calendar-query, multiget, sync-collection
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const calendarItem = home.calendar.getCalendarById(calendarId);
        if (!calendarItem) return new Response('Not Found', { status: 404 });

        const body = await request.text();
        const res = handleReport(home.calendar, calendarId, calendarItem, params.ownerId, body);
        const resBody = await res.clone().text();
        // Log report type + abbreviated response
        const reportType = body.includes('sync-collection')
            ? 'sync-collection'
            : body.includes('multiget')
              ? 'multiget'
              : 'calendar-query';
        const syncToken = body.match(/sync\/(\d+)/)?.[1] ?? 'none';
        const responseCount = (resBody.match(/<D:response>/g) || []).length;
        logDav(
            'REPORT',
            `/dav/calendars/.../${calendarId}/`,
            res.status,
            `type=${reportType} syncToken=${syncToken} responses=${responseCount}`,
        );
        return res;
    })

    // MKCALENDAR
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleMkcalendar(home.calendar, body);
    })

    // PROPPATCH
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleProppatch(home.calendar, calendarId, params.ownerId, body);
    });
