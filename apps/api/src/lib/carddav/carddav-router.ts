import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { uriKeyOf } from '../contacts/card-store';
import { getContacts } from '../contacts/contacts';
import { requireSelf } from '../core/access';
import {
    ADDRESSBOOK_ID,
    handleAddressbookHomePropfind,
    handleAddressbookPropfind,
    handleCardPropfind,
} from './discovery';

// The wildcard under /dav/addressbooks/:ownerId/ decoded to at most two segments — the book and, optionally, a
// card resource name. Card names are client-chosen, so every segment is percent-decoded (the webdav/xml.ts
// convention); a malformed escape or a third segment is a client error, not a silent misroute (spec § 4).
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
            const key = uriKeyOf(parsed.uri);
            const card = (await contacts.listCards()).find((c) => uriKeyOf(c.uri) === key);
            if (!card) return new Response('Not Found', { status: 404 });
            return handleCardPropfind(params.ownerId, card.uri, card.etag);
        }

        const cards = depth === '1' ? await contacts.listCards() : [];
        return handleAddressbookPropfind(params.ownerId, book, cards, depth);
    })

    // GET on a collection URL — a 200 stub so HEAD/GET probes pass (card resource GET is a later task).
    .get('/dav/addressbooks/:ownerId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        requireSelf(params.ownerId, user.id);
        const parsed = parseAddressbookPath(params['*']);
        if (!parsed.ok) return new Response('Bad Request', { status: 400 });
        if (!parsed.uri) {
            return new Response('This is a CardDAV endpoint. Use a CardDAV client.', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }
        return new Response('Not Found', { status: 404 });
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
