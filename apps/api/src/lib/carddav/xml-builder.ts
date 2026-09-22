import { escapeXml } from '@workspace/lib/html';
import { CARD_MAX_BYTES } from '../contacts/card-store';
import type { CardBook } from '../contacts/dav-store';
import { addressbookHomeHref } from '../dav/href';
import type { PropMap } from '../dav/propfind';
import { formatSyncToken } from '../dav/sync-token';
import { currentUserPrincipalProp, ownershipEntries } from '../dav/xml';

// Addressbook-specific property blocks only; the envelope, member props, sync-token and PROPFIND core live in lib/dav/.

// Addressbook home collection — the parent of the single book. Mirrors the CalDAV homeCollectionProps.
export function addressbookHomeProps(userId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/></D:resourcetype>`],
        ['displayname', `<D:displayname>Addressbooks</D:displayname>`],
        ['current-user-principal', currentUserPrincipalProp(userId)],
        [
            'addressbook-home-set',
            `<CARD:addressbook-home-set><D:href>${addressbookHomeHref(userId)}</D:href></CARD:addressbook-home-set>`,
        ],
        ...ownershipEntries(userId),
    ]);
}

// The sync-token carries the rebuild generation, so a rebuilt book forces a full resync instead of stalling clients.
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

export function addressDataProp(vcf: string): string {
    return `<CARD:address-data>${escapeXml(vcf)}</CARD:address-data>`;
}
