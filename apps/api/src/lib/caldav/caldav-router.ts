import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { EVENT_MAX_BYTES } from '../calendar/resource-store';
import { requireSelf } from '../core/access';
import { readBoundedBody } from '../core/http';
import { parseCollectionPath } from '../dav/href';
import { DAV_BODY_MAX_BYTES, parsePropfind, wantsBrief } from '../dav/propfind';
import { davError } from '../dav/xml';
import { getHome } from '../home';
import { handleCalendarHomePropfind, handlePrincipalPropfind, handleRootPropfind } from './discovery';
import { handleCalendarPropfind, handleEventPropfind } from './propfind';
import { handleDeleteCalendar, handleMkcalendar, handleProppatch } from './proppatch';
import { handleReport } from './report';
import { handleDelete, handleGet, handlePut } from './resource';

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
        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        const home = await getHome(params.ownerId);
        const calendars = await home.calendar.getCollections();
        const depth = request.headers.get('Depth') || '0';
        return handleCalendarHomePropfind(params.ownerId, calendars, depth, parsePropfind(body), wantsBrief(request));
    })

    // PROPFIND /dav/calendars/:ownerId/* — calendar collection or event listing
    .route('PROPFIND', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        const req = parsePropfind(body);
        const brief = wantsBrief(request);
        const home = await getHome(params.ownerId);
        const depth = request.headers.get('Depth') || '0';

        if (!parsed.collection) {
            return handleCalendarHomePropfind(params.ownerId, await home.calendar.getCollections(), depth, req, brief);
        }

        const calendar = await home.calendar.getCollection(parsed.collection);
        if (!calendar) return new Response('Not Found', { status: 404 });

        // A resource segment is a single-resource PROPFIND — its own href + etag, 404 if the uri is unknown.
        if (parsed.resource) {
            const resource = await home.calendar.getResourceMeta(parsed.collection, parsed.resource);
            if (!resource) return new Response('Not Found', { status: 404 });
            return handleEventPropfind(params.ownerId, parsed.collection, resource.uri, resource.etag, req, brief);
        }

        const resources = depth === '1' ? await home.calendar.listResources(parsed.collection) : [];
        return handleCalendarPropfind(params.ownerId, calendar, resources, depth, req, brief);
    })

    // GET .ics resource
    .get('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        // GET on collection URL (no resource) — return 200 so HEAD/GET checks pass
        if (!parsed.collection || !parsed.resource) {
            return new Response('This is a CalDAV endpoint. Use a CalDAV client.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        const home = await getHome(params.ownerId);
        return handleGet(home.calendar, parsed.collection, parsed.resource);
    })

    // PUT .ics resource
    .put('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok || !parsed.collection || !parsed.resource) {
            return new Response('Bad Request', { status: 400 });
        }

        const home = await getHome(params.ownerId);
        // Bound the body before buffering so a hostile PUT can't park up to server.ts's 1 GB server cap on the heap.
        const body = await readBoundedBody(request, EVENT_MAX_BYTES);
        if (body === null) return davError(413, '<C:max-resource-size/>');
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePut(
            home.calendar,
            params.ownerId,
            parsed.collection,
            parsed.resource,
            body,
            ifMatch,
            ifNoneMatch,
            user.id,
        );
    })

    // DELETE an .ics resource, or the calendar collection itself
    .delete('/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok || !parsed.collection) {
            return new Response('Bad Request', { status: 400 });
        }

        const home = await getHome(params.ownerId);
        if (!parsed.resource) return handleDeleteCalendar(home.calendar, parsed.collection);

        const ifMatch = request.headers.get('If-Match');
        return handleDelete(home.calendar, parsed.collection, parsed.resource, ifMatch);
    })

    // REPORT — calendar-query, multiget, sync-collection
    .route('REPORT', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok || !parsed.collection) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const collection = await home.calendar.getCollection(parsed.collection);
        if (!collection) return new Response('Not Found', { status: 404 });

        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleReport(home.calendar, parsed.collection, collection, params.ownerId, body);
    })

    // MKCALENDAR — creates a calendar at the client-chosen URL (one path segment, no resource part).
    .route('MKCALENDAR', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok || !parsed.collection || parsed.resource) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleMkcalendar(home.calendar, params.ownerId, parsed.collection, body);
    })

    // PROPPATCH
    .route('PROPPATCH', '/dav/calendars/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok || !parsed.collection) return new Response('Bad Request', { status: 400 });

        const home = await getHome(params.ownerId);
        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleProppatch(home.calendar, parsed.collection, params.ownerId, body);
    });
