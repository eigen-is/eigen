import type { CardRow } from '../contacts/contacts';
import {
    addressbookCollectionProps,
    addressbookHomeProps,
    cardEtagProp,
    multistatus,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from './xml-builder';

// The one fixed book: URL segment `contacts`, displayname `Contacts` (spec § 4, Non-goals — no MKADDRESSBOOK).
export const ADDRESSBOOK_ID = 'contacts';

const bookHref = (ownerId: string) => `/dav/addressbooks/${ownerId}/${ADDRESSBOOK_ID}/`;
const cardHref = (ownerId: string, uri: string) =>
    `/dav/addressbooks/${ownerId}/${ADDRESSBOOK_ID}/${encodeURIComponent(uri)}`;

function xml(responses: string[]): Response {
    return new Response(multistatus(responses), { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}

// PROPFIND /dav/addressbooks/{ownerId}/ — the home collection, plus the single book child at Depth:1.
export function handleAddressbookHomePropfind(
    ownerId: string,
    book: { ctag: number; syncGen: number },
    depth: string,
): Response {
    const responses = [response(`/dav/addressbooks/${ownerId}/`, [propstatOk(addressbookHomeProps(ownerId))])];
    if (depth === '1') {
        responses.push(response(bookHref(ownerId), [propstatOk(addressbookCollectionProps(book))]));
    }
    return xml(responses);
}

// PROPFIND /dav/addressbooks/{ownerId}/contacts/ — the book collection, plus one card per resource at Depth:1
// (etag + content-type). The card listing comes from the index; DAV serves every card, group cards included.
export function handleAddressbookPropfind(
    ownerId: string,
    book: { ctag: number; syncGen: number },
    cards: CardRow[],
    depth: string,
): Response {
    const responses = [response(bookHref(ownerId), [propstatOk(addressbookCollectionProps(book))])];
    if (depth === '1') {
        for (const card of cards) {
            responses.push(response(cardHref(ownerId, card.uri), [propstatOk(cardEtagProp(card.etag))]));
        }
    }
    return xml(responses);
}

// PROPFIND /dav/addressbooks/{ownerId}/contacts/{uri} — a single card resource.
export function handleCardPropfind(ownerId: string, uri: string, etag: string): Response {
    return xml([response(cardHref(ownerId, uri), [propstatOk(cardEtagProp(etag))])]);
}
