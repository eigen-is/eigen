import type { DrivePath } from '@workspace/lib/types/drive';

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

export type LockProps = {
    token: string;
    ownerHref?: string;
    depth: 0 | 'infinity';
    scope: 'exclusive' | 'shared';
    expiresAt: number;
};

export function lockdiscoveryProp(locks: LockProps[]): string {
    if (locks.length === 0) return '<D:lockdiscovery/>';
    const inner = locks
        .map((l) => {
            const owner = l.ownerHref ? `<D:owner>${escapeXml(l.ownerHref)}</D:owner>` : '';
            const timeoutSeconds = Math.max(1, Math.floor((l.expiresAt - Date.now()) / 1000));
            const depth = `<D:depth>${l.depth === 0 ? '0' : 'infinity'}</D:depth>`;
            const scope = l.scope === 'shared' ? '<D:shared/>' : '<D:exclusive/>';
            return `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope>${scope}</D:lockscope>${depth}${owner}<D:timeout>Second-${timeoutSeconds}</D:timeout><D:locktoken><D:href>${escapeXml(l.token)}</D:href></D:locktoken></D:activelock>`;
        })
        .join('');
    return `<D:lockdiscovery>${inner}</D:lockdiscovery>`;
}

export function supportedlockProp(): string {
    return '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry><D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';
}

// Files written through the drive API carry a SHA-256 hash; legacy/edge rows may
// not, so we fall back to a synthetic id+mtime+size triple. Quotes per RFC 7232.
export function computeEtag(path: Pick<DrivePath, 'hash' | 'id' | 'updatedAt' | 'size'>): string {
    const value = path.hash ?? `${path.id}-${path.updatedAt.getTime()}-${path.size}`;
    return `"${value}"`;
}

export function resourceProps(args: {
    path: DrivePath;
    isCollection: boolean;
    quotaUsed?: number;
    quotaAvailable?: number;
    locks?: LockProps[];
}): string[] {
    const { path, isCollection, quotaUsed, quotaAvailable, locks = [] } = args;
    const props: string[] = [
        `<D:displayname>${escapeXml(path.name)}</D:displayname>`,
        `<D:resourcetype>${isCollection ? '<D:collection/>' : ''}</D:resourcetype>`,
        `<D:creationdate>${path.createdAt.toISOString()}</D:creationdate>`,
        `<D:getlastmodified>${path.updatedAt.toUTCString()}</D:getlastmodified>`,
    ];
    if (!isCollection) {
        props.push(`<D:getcontentlength>${path.size}</D:getcontentlength>`);
        props.push(`<D:getcontenttype>${escapeXml(path.mimeType)}</D:getcontenttype>`);
        props.push(`<D:getetag>${computeEtag(path)}</D:getetag>`);
    }
    if (quotaUsed !== undefined) props.push(`<D:quota-used-bytes>${quotaUsed}</D:quota-used-bytes>`);
    if (quotaAvailable !== undefined)
        props.push(`<D:quota-available-bytes>${quotaAvailable}</D:quota-available-bytes>`);
    props.push(supportedlockProp());
    props.push(lockdiscoveryProp(locks));
    return props;
}
