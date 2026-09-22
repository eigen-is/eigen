import { escapeXml } from '@workspace/lib/html';
import { addressbookHomeHref, calendarHomeHref, principalHref } from './href';
import type { PropMap } from './propfind';

export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

const NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CARD="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"`;

function multistatus(responses: string[], extra?: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>${responses.join('')}${extra ?? ''}</D:multistatus>`;
}

// The 207 envelope every PROPFIND/REPORT answer ships in.
export function multistatusResponse(responses: string[], extra?: string): Response {
    return new Response(multistatus(responses, extra), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

// DAV:error wrapping one precondition element (RFC 3253 § 1.6); the namespaces are inline so the body stands alone.
export function davError(status: number, element: string): Response {
    return new Response(
        `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CARD="urn:ietf:params:xml:ns:carddav">${element}</D:error>`,
        { status, headers: { 'Content-Type': XML_CONTENT_TYPE } },
    );
}

export function response(href: string, propstats: string[]): string {
    return `<D:response><D:href>${escapeXml(href)}</D:href>${propstats.join('')}</D:response>`;
}

export function propstatOk(props: string[]): string {
    return `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
}

export function propstatNotFound(props: string[]): string {
    return `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
}

// Not interchangeable: a multiget names the prop it could not serve, a sync-collection removal carries a bare status (RFC 6578 § 3.2).
export const notFoundRow = (href: string) => response(href, [propstatNotFound(['<D:getetag/>'])]);
export const removedRow = (href: string) => response(href, ['<D:status>HTTP/1.1 404 Not Found</D:status>']);

const getetag = (etag: string) => `<D:getetag>"${escapeXml(etag)}"</D:getetag>`;
const getcontenttype = (contentType: string) => `<D:getcontenttype>${contentType}</D:getcontenttype>`;

// Single-sourced with the PROPFIND map below, so the two views cannot spell one resource differently.
export function memberProps(etag: string, contentType: string): string[] {
    return [getetag(etag), getcontenttype(contentType)];
}

// The empty resourcetype is RFC 4918's discriminator for a non-collection.
export function memberRowProps(etag: string, contentType: string): PropMap {
    return new Map([
        ['getetag', getetag(etag)],
        ['getcontenttype', getcontenttype(contentType)],
        ['resourcetype', `<D:resourcetype/>`],
    ]);
}

// The one property a client asks /dav/ for before it knows anything else.
export function currentUserPrincipalProp(userId: string): string {
    return `<D:current-user-principal><D:href>${principalHref(userId)}</D:href></D:current-user-principal>`;
}

export function principalProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>`,
        `<C:calendar-home-set><D:href>${calendarHomeHref(userId)}</D:href></C:calendar-home-set>`,
        // One principal serves both protocols; clients read only the props they know.
        `<CARD:addressbook-home-set><D:href>${addressbookHomeHref(userId)}</D:href></CARD:addressbook-home-set>`,
        `<D:principal-URL><D:href>${principalHref(userId)}</D:href></D:principal-URL>`,
    ];
}

// Apple's AddressBook and Calendar read editability from these props: a server that omits them is read-only, and every edit lands as a new resource with a fresh UID.
export function ownershipEntries(ownerId: string): [string, string][] {
    return [
        [
            'current-user-privilege-set',
            `<D:current-user-privilege-set><D:privilege><D:all/></D:privilege><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege></D:current-user-privilege-set>`,
        ],
        ['owner', `<D:owner><D:href>${principalHref(ownerId)}</D:href></D:owner>`],
    ];
}
