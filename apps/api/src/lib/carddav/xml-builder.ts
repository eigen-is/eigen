import { CARD_MAX_BYTES } from '../contacts/card-store';
import type { CardBook } from '../contacts/dav-store';
import type { PropMap } from '../dav/propfind';
// The multistatus/response/propstat helpers and the shared NS string (which already declares the CARD
// namespace) live in the shared DAV envelope (lib/dav/xml.ts) — one principal and one XML envelope serve both
// protocols, so these are imported, never duplicated. This file only adds the addressbook-specific property blocks.
import { ownershipEntries } from '../dav/xml';
import { escapeXml } from '../shared/xml';

export { PROPFIND_BODY_MAX_BYTES, parsePropfind, selectProps, wantsBrief } from '../dav/propfind';
export {
    davError,
    multistatus,
    multistatusResponse,
    propstatNotFound,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from '../dav/xml';

// The addressbook HOME, one level above discovery.ts's bookHref (which points at the book itself).
const homeHref = (userId: string) => `/dav/addressbooks/${userId}/`;

// RFC 6578 token, generation-stamped so a rebuilt index invalidates every outstanding token. The only two
// sites allowed to spell the grammar — emit/parse drift would 412 every client into a full-resync loop.
export const formatSyncToken = (book: CardBook) => `urn:eigen:sync:${book.syncGen}-${book.ctag}`;

export function parseSyncToken(token: string): { gen: number; since: number } | null {
    const m = /^urn:eigen:sync:(\d+)-(\d+)$/.exec(token);
    return m ? { gen: Number(m[1]), since: Number(m[2]) } : null;
}

// Addressbook home collection — the parent of the single book. Mirrors the CalDAV homeCollectionProps.
export function addressbookHomeProps(userId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/></D:resourcetype>`],
        ['displayname', `<D:displayname>Addressbooks</D:displayname>`],
        [
            'current-user-principal',
            `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`,
        ],
        [
            'addressbook-home-set',
            `<CARD:addressbook-home-set><D:href>${homeHref(userId)}</D:href></CARD:addressbook-home-set>`,
        ],
        ...ownershipEntries(userId),
    ]);
}

// The one fixed book named "Contacts". supported-report-set advertises exactly the REPORTs that exist (spec
// § 4 — no expand-property); the sync-token carries the rebuild generation so a rebuilt book forces a full
// resync instead of stalling clients on a stale counter.
export function addressbookCollectionProps(book: CardBook, ownerId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>`],
        ['displayname', `<D:displayname>Contacts</D:displayname>`],
        ...ownershipEntries(ownerId),
        ['getctag', `<CS:getctag>${book.ctag}</CS:getctag>`],
        ['sync-token', `<D:sync-token>${formatSyncToken(book)}</D:sync-token>`],
        [
            'supported-address-data',
            `<CARD:supported-address-data><CARD:address-data-type content-type="text/vcard" version="3.0"/></CARD:supported-address-data>`,
        ],
        ['max-resource-size', `<CARD:max-resource-size>${CARD_MAX_BYTES}</CARD:max-resource-size>`],
        [
            'supported-report-set',
            `<D:supported-report-set><D:supported-report><D:report><CARD:addressbook-multiget/></D:report></D:supported-report><D:supported-report><D:report><CARD:addressbook-query/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
        ],
    ]);
}

// The two card member fragments, single-sourced so the REPORT view (cardEtagProp) and the PROPFIND row map
// (cardRowProps) can't drift.
const cardGetetag = (etag: string) => `<D:getetag>"${escapeXml(etag)}"</D:getetag>`;
const CARD_CONTENT_TYPE = `<D:getcontenttype>text/vcard; charset=utf-8</D:getcontenttype>`;

// Card resource properties for REPORT rows (etag + content-type).
export function cardEtagProp(etag: string): string[] {
    return [cardGetetag(etag), CARD_CONTENT_TYPE];
}

// Card member row for PROPFIND: the REPORT pair plus the empty resourcetype marking it a non-collection member.
export function cardRowProps(etag: string): PropMap {
    return new Map([
        ['getetag', cardGetetag(etag)],
        ['getcontenttype', CARD_CONTENT_TYPE],
        ['resourcetype', `<D:resourcetype/>`],
    ]);
}

// The card body inside a REPORT response — the stored vCard bytes (or the partial-retrieval projection of
// them), XML-escaped, in a CARD:address-data element.
export function addressDataProp(vcf: string): string {
    return `<CARD:address-data>${escapeXml(vcf)}</CARD:address-data>`;
}
