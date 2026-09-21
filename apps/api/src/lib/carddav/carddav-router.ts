import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { CARD_MAX_BYTES, sanitizeCardUri } from '../contacts/card-store';
import { getContacts } from '../contacts/contacts';
import { requireSelf } from '../core/access';
import { readBoundedBody } from '../core/http';
import { type CollectionPath, parseCollectionPath } from '../dav/href';
import { DAV_BODY_MAX_BYTES, parsePropfind, wantsBrief } from '../dav/propfind';
import { davError } from '../dav/xml';
import {
    ADDRESSBOOK_ID,
    handleAddressbookHomePropfind,
    handleAddressbookPropfind,
    handleCardPropfind,
} from './discovery';
import { handleCardReport } from './report';
import { handleDeleteCard, handleGetCard, handlePutCard } from './resource';

// The shared GET/PUT/DELETE card-resource tail: fixed-book check, then sanitize the client-chosen name before
// it can become a filename (the AGENTS.md path rule). Returns the refusal Response to serve as-is.
function resolveCardUri(parsed: CollectionPath): { uri: string } | Response {
    if (!parsed.ok) return new Response('Bad Request', { status: 400 });
    if (parsed.collection !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });
    if (!parsed.resource) return new Response('Bad Request', { status: 400 });
    const uri = sanitizeCardUri(parsed.resource);
    if (!uri) return new Response('Bad Request', { status: 400 });
    return { uri };
}

// One fixed book per user — MKCOL and MKADDRESSBOOK both create another collection, so both are forbidden.
async function forbidCollectionCreate({
    request,
    params,
}: {
    request: Request;
    params: { ownerId: string };
}): Promise<Response> {
    const user = await authenticateBasic(request);
    requireSelf(params.ownerId, user.id);
    return new Response('Forbidden', { status: 403 });
}

export const carddavRouter = new Elysia({ name: 'carddav' })
    // PROPFIND /dav/addressbooks/:ownerId — addressbook home (the /* route catches the trailing-slash variant)
    .route('PROPFIND', '/dav/addressbooks/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        const contacts = await getContacts(user);
        const depth = request.headers.get('Depth') || '0';
        return handleAddressbookHomePropfind(
            params.ownerId,
            await contacts.getBook(),
            depth,
            parsePropfind(body),
            wantsBrief(request),
        );
    })

    // PROPFIND /dav/addressbooks/:ownerId/* — home, the book collection, or a single card resource
    .route('PROPFIND', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        const req = parsePropfind(body);
        const brief = wantsBrief(request);
        const contacts = await getContacts(user);
        const book = await contacts.getBook();
        const depth = request.headers.get('Depth') || '0';

        if (!parsed.collection) return handleAddressbookHomePropfind(params.ownerId, book, depth, req, brief);
        // One fixed book named 'contacts'; any other name is a 404 (no MKADDRESSBOOK).
        if (parsed.collection !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });

        // A second segment is a single-resource PROPFIND — index-only lookup by folded uri key, 404 if unknown.
        if (parsed.resource) {
            const card = await contacts.getCardMeta(parsed.resource);
            if (!card) return new Response('Not Found', { status: 404 });
            return handleCardPropfind(params.ownerId, card.uri, card.etag, req, brief);
        }

        const cards = depth === '1' ? await contacts.listCards() : [];
        return handleAddressbookPropfind(params.ownerId, book, cards, depth, req, brief);
    })

    // GET a card resource, or a 200 stub on the collection URL so HEAD/GET probes pass.
    .get('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        // The stub answers any well-formed collection URL before the book check — the CalDAV twin's order.
        if (parsed.ok && !parsed.resource) {
            return new Response('This is a CardDAV endpoint. Use a CardDAV client.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }
        const resolved = resolveCardUri(parsed);
        if (resolved instanceof Response) return resolved;
        return handleGetCard(await getContacts(user), resolved.uri);
    })

    // PUT a card resource — create or replace. The name is sanitized before putCard turns it into a filename,
    // and the If-Match / If-None-Match preconditions are evaluated inside the store's write lock.
    .put('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const resolved = resolveCardUri(parseCollectionPath(params['*']));
        if (resolved instanceof Response) return resolved;

        // Bound the body before buffering (1 GB server cap → heap); putCard re-checks CARD_MAX_BYTES as the
        // store guard for its non-HTTP callers.
        const body = await readBoundedBody(request, CARD_MAX_BYTES);
        if (body === null) return davError(413, '<CARD:max-resource-size/>');
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePutCard(await getContacts(user), params.ownerId, resolved.uri, body, ifMatch, ifNoneMatch);
    })

    // DELETE a card resource — 404 for an unknown name (DAV DELETE is not idempotent), 403 for your own card.
    .delete('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const resolved = resolveCardUri(parseCollectionPath(params['*']));
        if (resolved instanceof Response) return resolved;

        const ifMatch = request.headers.get('If-Match');
        return handleDeleteCard(await getContacts(user), resolved.uri, ifMatch);
    })

    // REPORT — addressbook-multiget, addressbook-query, sync-collection. Targets the book collection (a REPORT
    // on the home collection has nothing to report on → 400, like caldav's no-calendarId branch). The body cap
    // is enforced HERE, before the body reaches the XML parser.
    .route('REPORT', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseCollectionPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });
        if (!parsed.collection) return new Response('Bad Request', { status: 400 });
        if (parsed.collection !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });

        const body = await readBoundedBody(request, DAV_BODY_MAX_BYTES);
        if (body === null) return new Response('Payload Too Large', { status: 413 });
        return handleCardReport(await getContacts(user), params.ownerId, body);
    })

    .route('MKCOL', '/dav/addressbooks/:ownerId/*', forbidCollectionCreate)
    .route('MKADDRESSBOOK', '/dav/addressbooks/:ownerId/*', forbidCollectionCreate);
