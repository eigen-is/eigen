import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { sanitizeCardUri } from '../contacts/card-store';
import { getContacts } from '../contacts/contacts';
import { requireSelf } from '../core/access';
import {
    ADDRESSBOOK_ID,
    handleAddressbookHomePropfind,
    handleAddressbookPropfind,
    handleCardPropfind,
} from './discovery';
import { handleCardReport, REPORT_BODY_MAX_BYTES } from './report';
import { handleDeleteCard, handleGetCard, handlePutCard } from './resource';

// The wildcard decodes to at most two segments — the book and an optional card name. Card names are
// client-chosen, so every segment is percent-decoded (the webdav/xml.ts convention); a malformed escape or a
// third segment is a client error, not a silent misroute (spec § 4).
type ParsedPath = { ok: true; book: string | null; uri: string | null } | { ok: false };

function parseAddressbookPath(wildcard: string): ParsedPath {
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
    return { ok: true, book: decoded[0] ?? null, uri: decoded[1] ?? null };
}

// The shared GET/PUT/DELETE card-resource tail: fixed-book check, then sanitize the client-chosen name before
// it can become a filename (the AGENTS.md path rule). Returns the refusal Response to serve as-is.
function resolveCardUri(parsed: ParsedPath): { uri: string } | Response {
    if (!parsed.ok) return new Response('Bad Request', { status: 400 });
    if (parsed.book !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });
    if (!parsed.uri) return new Response('Bad Request', { status: 400 });
    const uri = sanitizeCardUri(parsed.uri);
    if (!uri) return new Response('Bad Request', { status: 400 });
    return { uri };
}

export const carddavRouter = new Elysia({ name: 'carddav' })
    // PROPFIND /dav/addressbooks/:ownerId — addressbook home (the /* route catches the trailing-slash variant)
    .route('PROPFIND', '/dav/addressbooks/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const contacts = await getContacts(user);
        const depth = request.headers.get('Depth') || '0';
        return handleAddressbookHomePropfind(params.ownerId, await contacts.getBook(), depth);
    })

    // PROPFIND /dav/addressbooks/:ownerId/* — home, the book collection, or a single card resource
    .route('PROPFIND', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseAddressbookPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });

        const contacts = await getContacts(user);
        const book = await contacts.getBook();
        const depth = request.headers.get('Depth') || '0';

        // Empty wildcard — the home collection itself.
        if (!parsed.book) return handleAddressbookHomePropfind(params.ownerId, book, depth);
        // One fixed book named 'contacts'; any other name is a 404 (no MKADDRESSBOOK, spec § 4).
        if (parsed.book !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });

        // A second segment is a single-resource PROPFIND — index-only lookup by folded uri key, 404 if unknown.
        if (parsed.uri) {
            const card = await contacts.getCardMeta(parsed.uri);
            if (!card) return new Response('Not Found', { status: 404 });
            return handleCardPropfind(params.ownerId, card.uri, card.etag);
        }

        const cards = depth === '1' ? await contacts.listCards() : [];
        return handleAddressbookPropfind(params.ownerId, book, cards, depth);
    })

    // GET a card resource, or a 200 stub on the collection URL so HEAD/GET probes pass.
    .get('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseAddressbookPath(params['*']);
        // The stub answers any well-formed collection URL before the book check — the CalDAV twin's order.
        if (parsed.ok && !parsed.uri) {
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
    // and the If-Match / If-None-Match preconditions are evaluated inside the store's write lock (spec § 3).
    .put('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const resolved = resolveCardUri(parseAddressbookPath(params['*']));
        if (resolved instanceof Response) return resolved;

        const body = await request.text();
        const ifMatch = request.headers.get('If-Match');
        const ifNoneMatch = request.headers.get('If-None-Match');
        return handlePutCard(await getContacts(user), params.ownerId, resolved.uri, body, ifMatch, ifNoneMatch);
    })

    // DELETE a card resource — 404 for an unknown name (DAV DELETE is not idempotent), 403 for your own card.
    .delete('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const resolved = resolveCardUri(parseAddressbookPath(params['*']));
        if (resolved instanceof Response) return resolved;

        const ifMatch = request.headers.get('If-Match');
        return handleDeleteCard(await getContacts(user), resolved.uri, ifMatch);
    })

    // REPORT — addressbook-multiget, addressbook-query, sync-collection. Targets the book collection (a REPORT
    // on the home collection has nothing to report on → 400, like caldav's no-calendarId branch). The 1 MiB
    // body cap is enforced HERE, before the body reaches the XML parser (spec § 4).
    .route('REPORT', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseAddressbookPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });
        if (!parsed.book) return new Response('Bad Request', { status: 400 });
        if (parsed.book !== ADDRESSBOOK_ID) return new Response('Not Found', { status: 404 });

        const body = await request.text();
        if (Buffer.byteLength(body) > REPORT_BODY_MAX_BYTES) return new Response('Payload Too Large', { status: 413 });
        return handleCardReport(await getContacts(user), params.ownerId, body);
    })

    // One fixed book per user — creating another collection is forbidden (spec Non-goals).
    .route('MKCOL', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        return new Response('Forbidden', { status: 403 });
    })
    .route('MKADDRESSBOOK', '/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        return new Response('Forbidden', { status: 403 });
    });
