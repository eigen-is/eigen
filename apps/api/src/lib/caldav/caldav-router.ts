import Elysia from 'elysia';
import { getHome } from '../home';
import { authenticateBasic } from './auth';
import { handleCalendarHomePropfind, handlePrincipalPropfind, handleRootPropfind } from './discovery';
import { handleCalendarPropfind } from './propfind';
import { handleMkcalendar, handleProppatch } from './proppatch';
import { handleReport } from './report';
import { handleDelete, handleGet, handlePut } from './resource';

const DAV_HEADERS = {
    DAV: '1, 2, 3, calendar-access',
    Allow: 'OPTIONS, GET, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR',
};

function parseDavPath(wildcard: string): { calendarId?: string; resourceUri?: string } {
    // wildcard comes from Elysia's /dav/calendars/:ownerId/*
    // Could be: "" (collection), "calId/" (calendar), "calId/event.ics" (resource)
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
    // OPTIONS — DAV capability advertisement (no auth needed)
    .options('/dav/*', ({ set }) => {
        Object.assign(set.headers, DAV_HEADERS);
        return '';
    })
    .options('/dav', ({ set }) => {
        Object.assign(set.headers, DAV_HEADERS);
        return '';
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

    // PROPFIND /dav/principals/:ownerId/ (with or without trailing content)
    .route('PROPFIND', '/dav/principals/:ownerId', async ({ request, params }) => {
        await authenticateBasic(request);
        return handlePrincipalPropfind(params.ownerId);
    })
    .route('PROPFIND', '/dav/principals/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        return handlePrincipalPropfind(params.ownerId);
    })

    // PROPFIND /dav/calendars/:ownerId/ — calendar home (list calendars)
    .route('PROPFIND', '/dav/calendars/:ownerId', async ({ request, params }) => {
        await authenticateBasic(request);
        const home = await getHome(params.ownerId);
        const calendars = home.calendar.getCalendars();
        const depth = request.headers.get('Depth') || '0';
        return handleCalendarHomePropfind(params.ownerId, calendars, depth);
    })

    // PROPFIND /dav/calendars/:ownerId/* — calendar collection or event listing
    .route('PROPFIND', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId } = parseDavPath(params['*']);

        if (!calendarId) {
            // Same as calendar home
            const home = await getHome(params.ownerId);
            const calendars = home.calendar.getCalendars();
            const depth = request.headers.get('Depth') || '0';
            return handleCalendarHomePropfind(params.ownerId, calendars, depth);
        }

        // Calendar collection PROPFIND
        const home = await getHome(params.ownerId);
        const calendar = home.calendar.getCalendarById(calendarId);
        if (!calendar) return new Response('Not Found', { status: 404 });
        const depth = request.headers.get('Depth') || '0';
        const events = depth === '1' ? home.calendar.getRawEvents(calendarId) : [];
        return handleCalendarPropfind(params.ownerId, calendar, events, depth);
    })

    // GET /dav/calendars/:ownerId/:calendarId/:uri — fetch .ics resource
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Not Found', { status: 404 });

        const home = await getHome(params.ownerId);
        const event = home.calendar.getEventByUri(calendarId, resourceUri);
        if (!event) return new Response('Not Found', { status: 404 });

        const allEvents = home.calendar.getRawEvents(calendarId).filter((e) => e.uid === event.uid);
        return handleGet(event, allEvents);
    })

    // PUT /dav/calendars/:ownerId/:calendarId/:uri — create or update .ics resource
    .put('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePut(home.calendar, calendarId, resourceUri, body, ifMatch, ifNoneMatch, user.id);
    })

    // DELETE /dav/calendars/:ownerId/:calendarId/:uri — delete .ics resource
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId, resourceUri } = parseDavPath(params['*']);
        if (!calendarId || !resourceUri) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const ifMatch = request.headers.get('If-Match');
        return handleDelete(home.calendar, calendarId, resourceUri, ifMatch);
    })

    // REPORT /dav/calendars/:ownerId/:calendarId/ — calendar-query, multiget, sync-collection
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const calendarItem = home.calendar.getCalendarById(calendarId);
        if (!calendarItem) return new Response('Not Found', { status: 404 });

        const body = await request.text();
        return handleReport(home.calendar, calendarId, calendarItem, params.ownerId, body);
    })

    // MKCALENDAR /dav/calendars/:ownerId/:calendarId/ — create a new calendar collection
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleMkcalendar(home.calendar, body);
    })

    // PROPPATCH /dav/calendars/:ownerId/:calendarId/ — update calendar properties
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        await authenticateBasic(request);
        const { calendarId } = parseDavPath(params['*']);
        if (!calendarId) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await request.text();
        return handleProppatch(home.calendar, calendarId, body);
    });
