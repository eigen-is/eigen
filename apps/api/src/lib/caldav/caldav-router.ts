import Elysia from 'elysia';
import { ApiError } from '../core/errors';
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

export const caldavRouter = new Elysia({ name: 'caldav' })
    // Debug logging (temporary)
    .onAfterHandle(({ request, set }) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/dav')) {
            const depth = request.headers.get('Depth') ?? '-';
            console.log(`[CalDAV] ${set.status} ${request.method} ${url.pathname} Depth:${depth}`);
        }
    })
    // Add WWW-Authenticate header on 401 errors for CalDAV paths
    .onError(({ set, request, error }) => {
        if (error instanceof ApiError && error.status === 401 && new URL(request.url).pathname.startsWith('/dav')) {
            set.status = 401;
            set.headers['WWW-Authenticate'] = 'Basic realm="Eigen CalDAV"';
            return 'Unauthorized';
        }
    })
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
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        return handlePrincipalPropfind(params.ownerId);
    })
    .route('PROPFIND', '/dav/principals/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        return handlePrincipalPropfind(params.ownerId);
    })

    // PROPFIND /dav/calendars/:ownerId/ — calendar home
    .route('PROPFIND', '/dav/calendars/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const home = await getHome(params.ownerId);
        const calendars = home.calendar.getCalendars();
        const depth = request.headers.get('Depth') || '0';
        return handleCalendarHomePropfind(params.ownerId, calendars, depth);
    })

    // PROPFIND /dav/calendars/:ownerId/* — calendar collection or event listing
    .route('PROPFIND', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
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
        return handleCalendarPropfind(params.ownerId, calendar, events, depth);
    })

    // GET .ics resource
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
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
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePut(home.calendar, params.ownerId, calendarId, resourceUri, body, ifMatch, ifNoneMatch, user.id);
    })

    // DELETE .ics resource
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const ifMatch = request.headers.get('If-Match');
        return handleDelete(home.calendar, calendarId, resourceUri, ifMatch);
    })

    // REPORT — calendar-query, multiget, sync-collection
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const calendarItem = home.calendar.getCalendarById(calendarId);
        if (!calendarItem) return new Response('Not Found', { status: 404 });

        const body = await request.text();
        return handleReport(home.calendar, calendarId, calendarItem, params.ownerId, body);
    })

    // MKCALENDAR
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleMkcalendar(home.calendar, body);
    })

    // PROPPATCH
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        if (user.id !== params.ownerId) throw new ApiError(403, 'Access denied');
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleProppatch(home.calendar, calendarId, params.ownerId, body);
    });
