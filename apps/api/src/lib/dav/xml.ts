import { escapeXml } from '../shared/xml';

export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

const NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CARD="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"`;

export function multistatus(responses: string[], extra?: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>${responses.join('')}${extra ?? ''}</D:multistatus>`;
}

// The 207 envelope every PROPFIND/REPORT answer ships in.
export function multistatusResponse(responses: string[], extra?: string): Response {
    return new Response(multistatus(responses, extra), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

// DAV:error wrapping one precondition element (RFC 3253 § 1.6), e.g. <D:valid-sync-token/>; namespaces are
// declared inline so the body stands alone.
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

// Principal properties
export function principalProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>`,
        `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`,
        // One principal serves both protocols; clients read only the props they know (spec § 4).
        `<CARD:addressbook-home-set><D:href>/dav/addressbooks/${userId}/</D:href></CARD:addressbook-home-set>`,
        `<D:principal-URL><D:href>/dav/principals/${userId}/</D:href></D:principal-URL>`,
    ];
}
