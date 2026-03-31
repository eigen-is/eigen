import Elysia from 'elysia';
import { getHome } from '../home';
import { authenticateBasic } from './auth';
import { handleCalendarHomePropfind, handlePrincipalPropfind, handleRootPropfind } from './discovery';

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

        // Calendar collection PROPFIND — will be implemented in Task 9
        return new Response('Not Implemented', { status: 501 });
    })

    // Stub routes for later tasks (REPORT, GET, PUT, DELETE, MKCALENDAR, PROPPATCH)
    .route('REPORT', '/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    })
    .get('/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    })
    .put('/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    })
    .delete('/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    })
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    })
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async () => {
        return new Response('Not Implemented', { status: 501 });
    });
