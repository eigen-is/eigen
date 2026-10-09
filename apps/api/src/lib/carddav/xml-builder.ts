import { escapeXmlText } from '@workspace/lib/xml';
import { CARD_MAX_BYTES } from '../contacts/card-store';
import type { CardBook } from '../contacts/dav-store';
import { addressbookHomeHref } from '../dav/href';
import type { PropMap } from '../dav/propfind';
import { formatSyncToken } from '../dav/sync-token';
import { currentUserPrincipalProp, ownershipProps, propMap } from '../dav/xml';

// Addressbook-specific property blocks only; the envelope, member props, sync-token and PROPFIND core live in lib/dav/.

// Addressbook home collection — the parent of the single book. Mirrors the CalDAV homeCollectionProps.
export function addressbookHomeProps(userId: string): PropMap {
    return propMap([
        `<D:resourcetype><D:collection/></D:resourcetype>`,
        `<D:displayname>Addressbooks</D:displayname>`,
        currentUserPrincipalProp(userId),
        `<CARD:addressbook-home-set><D:href>${addressbookHomeHref(userId)}</D:href></CARD:addressbook-home-set>`,
        ...ownershipProps(userId),
    ]);
}

// The sync-token carries the rebuild generation, so a rebuilt book forces a full resync instead of stalling clients.
export function addressbookCollectionProps(book: CardBook, ownerId: string): PropMap {
    return propMap([
        `<D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>`,
        `<D:displayname>Contacts</D:displayname>`,
        ...ownershipProps(ownerId),
        `<CS:getctag>${book.ctag}</CS:getctag>`,
        `<D:sync-token>${formatSyncToken(book)}</D:sync-token>`,
        `<CARD:supported-address-data><CARD:address-data-type content-type="text/vcard" version="3.0"/></CARD:supported-address-data>`,
        `<CARD:max-resource-size>${CARD_MAX_BYTES}</CARD:max-resource-size>`,
        `<D:supported-report-set><D:supported-report><D:report><CARD:addressbook-multiget/></D:report></D:supported-report><D:supported-report><D:report><CARD:addressbook-query/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
    ]);
}

export function addressDataProp(vcf: string): string {
    return `<CARD:address-data>${escapeXmlText(vcf)}</CARD:address-data>`;
}
