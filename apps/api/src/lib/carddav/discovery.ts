import { VCARD_CONTENT_TYPE } from '@workspace/lib/constants/contact';
import type { CardBook, CardRow } from '../contacts/dav-store';
import { addressbookHomeHref, encodePathSegment } from '../dav/href';
import { type PropfindRequest, selectProps } from '../dav/propfind';
import { memberRowProps, multistatusResponse, response } from '../dav/xml';
import { addressbookCollectionProps, addressbookHomeProps } from './xml-builder';

// The one fixed book: URL segment `contacts`, displayname `Contacts` — no MKADDRESSBOOK.
export const ADDRESSBOOK_ID = 'contacts';

// Card names are client-chosen, so the resource segment goes through the shared dav/href encoder.
export const bookHref = (ownerId: string) => `${addressbookHomeHref(ownerId)}${ADDRESSBOOK_ID}/`;
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
        response(addressbookHomeHref(ownerId), selectProps(addressbookHomeProps(ownerId), request, brief)),
    ];
    if (depth === '1') {
        responses.push(
            response(bookHref(ownerId), selectProps(addressbookCollectionProps(book, ownerId), request, brief)),
        );
    }
    return multistatusResponse(responses);
}

// PROPFIND /dav/addressbooks/{ownerId}/contacts/ — DAV serves every card in the index, group cards included.
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
            responses.push(
                response(
                    cardHref(ownerId, card.uri),
                    selectProps(memberRowProps(card.etag, VCARD_CONTENT_TYPE), request, brief),
                ),
            );
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
    return multistatusResponse([
        response(cardHref(ownerId, uri), selectProps(memberRowProps(etag, VCARD_CONTENT_TYPE), request, brief)),
    ]);
}
