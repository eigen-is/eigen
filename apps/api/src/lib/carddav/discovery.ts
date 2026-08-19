import type { CardBook, CardRow } from '../contacts/dav-store';
import { encodePathSegment } from '../dav/href';
import type { PropfindRequest } from '../dav/propfind';
import {
    addressbookCollectionProps,
    addressbookHomeProps,
    cardRowProps,
    multistatusResponse,
    response,
    selectProps,
} from './xml-builder';

// The one fixed book: URL segment `contacts`, displayname `Contacts` (spec § 4, Non-goals — no MKADDRESSBOOK).
export const ADDRESSBOOK_ID = 'contacts';

// The two href shapes every CardDAV surface emits (discovery, REPORT rows, the PUT Location header), so the
// book segment and the escaping rule live in one place. Card names are client-chosen, so the resource segment
// is minimally path-encoded via the shared dav/href encoder — the same one the CalDAV twin's eventHref uses.
export const bookHref = (ownerId: string) => `/dav/addressbooks/${ownerId}/${ADDRESSBOOK_ID}/`;
export const cardHref = (ownerId: string, uri: string) => `${bookHref(ownerId)}${encodePathSegment(uri)}`;

// PROPFIND /dav/addressbooks/{ownerId}/ — the home collection, plus the single book child at Depth:1.
export function handleAddressbookHomePropfind(
    ownerId: string,
    book: CardBook,
    depth: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    const responses = [
        response(`/dav/addressbooks/${ownerId}/`, selectProps(addressbookHomeProps(ownerId), request, brief)),
    ];
    if (depth === '1') {
        responses.push(
            response(bookHref(ownerId), selectProps(addressbookCollectionProps(book, ownerId), request, brief)),
        );
    }
    return multistatusResponse(responses);
}

// PROPFIND /dav/addressbooks/{ownerId}/contacts/ — the book collection, plus one card per resource at Depth:1
// (etag + content-type). The card listing comes from the index; DAV serves every card, group cards included.
export function handleAddressbookPropfind(
    ownerId: string,
    book: CardBook,
    cards: CardRow[],
    depth: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    const responses = [
        response(bookHref(ownerId), selectProps(addressbookCollectionProps(book, ownerId), request, brief)),
    ];
    if (depth === '1') {
        for (const card of cards) {
            responses.push(response(cardHref(ownerId, card.uri), selectProps(cardRowProps(card.etag), request, brief)));
        }
    }
    return multistatusResponse(responses);
}

// PROPFIND /dav/addressbooks/{ownerId}/contacts/{uri} — a single card resource.
export function handleCardPropfind(
    ownerId: string,
    uri: string,
    etag: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    return multistatusResponse([response(cardHref(ownerId, uri), selectProps(cardRowProps(etag), request, brief))]);
}
