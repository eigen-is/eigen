import { CARD_MAX_BYTES } from '../contacts/card-store';
import { escapeXml } from '../shared/xml';

// The multistatus/response/propstat helpers and the shared NS string (which already declares the CARD
// namespace) live in the CalDAV builder — one principal and one XML envelope serve both protocols, so these
// are imported, never duplicated. This file only adds the addressbook-specific property blocks.
export {
    currentUserPrincipalProp,
    multistatus,
    propstatNotFound,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from '../caldav/xml-builder';

const BOOK_HREF = (userId: string) => `/dav/addressbooks/${userId}/`;

// Addressbook home collection — the parent of the single book. Mirrors the CalDAV homeCollectionProps.
export function addressbookHomeProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/></D:resourcetype>`,
        `<D:displayname>Addressbooks</D:displayname>`,
        `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`,
        `<CARD:addressbook-home-set><D:href>${BOOK_HREF(userId)}</D:href></CARD:addressbook-home-set>`,
    ];
}

// The one fixed book named "Contacts". supported-report-set advertises exactly the REPORTs that exist (spec
// § 4 — no expand-property); the sync-token carries the rebuild generation so a rebuilt book forces a full
// resync instead of stalling clients on a stale counter.
export function addressbookCollectionProps(book: { ctag: number; syncGen: number }): string[] {
    return [
        `<D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>`,
        `<D:displayname>Contacts</D:displayname>`,
        `<CS:getctag>${book.ctag}</CS:getctag>`,
        `<D:sync-token>urn:eigen:sync:${book.syncGen}-${book.ctag}</D:sync-token>`,
        `<CARD:supported-address-data><CARD:address-data-type content-type="text/vcard" version="3.0"/></CARD:supported-address-data>`,
        `<CARD:max-resource-size>${CARD_MAX_BYTES}</CARD:max-resource-size>`,
        `<D:supported-report-set><D:supported-report><D:report><CARD:addressbook-multiget/></D:report></D:supported-report><D:supported-report><D:report><CARD:addressbook-query/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
    ];
}

// Card resource properties (etag + content-type, used in PROPFIND Depth:1 and single-resource PROPFIND).
export function cardEtagProp(etag: string): string[] {
    return [
        `<D:getetag>"${escapeXml(etag)}"</D:getetag>`,
        `<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>`,
    ];
}
