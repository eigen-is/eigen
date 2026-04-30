const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>';

export function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function multistatus(responses: string[]): string {
    return `${XML_HEADER}\n<D:multistatus xmlns:D="DAV:">\n${responses.join('\n')}\n</D:multistatus>`;
}

export function response(href: string, propstats: string[]): string {
    return `<D:response>\n<D:href>${escapeXml(href)}</D:href>\n${propstats.join('\n')}\n</D:response>`;
}

export function propstatOk(props: string[]): string {
    return `<D:propstat>\n<D:prop>\n${props.join('\n')}\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>`;
}

export function propstatNotFound(props: string[]): string {
    return `<D:propstat>\n<D:prop>\n${props.join('\n')}\n</D:prop>\n<D:status>HTTP/1.1 404 Not Found</D:status>\n</D:propstat>`;
}

export function propstatStatus(status: number, statusText: string, props: string[]): string {
    return `<D:propstat>\n<D:prop>\n${props.join('\n')}\n</D:prop>\n<D:status>HTTP/1.1 ${status} ${statusText}</D:status>\n</D:propstat>`;
}

export function buildXmlResponse(body: string, status = 207): Response {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-cache, must-revalidate',
        },
    });
}

// Finder sends NFD-decomposed UTF-8; encode each segment via encodeURIComponent
// then rejoin with '/' so multi-byte chars round-trip while keeping path separators.
export function encodeHref(path: string): string {
    return path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
}
