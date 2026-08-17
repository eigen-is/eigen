import type { DrivePath } from '@workspace/lib/types/drive';

// Default private: these bodies are per-user; a shared cache must never store them.
// 'public' is reserved for the unauthenticated /p/ surface (routes/public.ts).
export function setCacheHeaders(
    set: { headers: Record<string, string | number> },
    maxAgeSeconds: number,
    visibility: 'private' | 'public' = 'private',
): void {
    set.headers['Cache-Control'] = `${visibility}, max-age=${maxAgeSeconds}`;
}

// Files written through the drive API carry a SHA-256 hash; legacy/edge rows may
// not, so we fall back to a synthetic id+mtime+size triple. Quotes per RFC 7232.
export function computeEtag(path: Pick<DrivePath, 'hash' | 'id' | 'updatedAt' | 'size'>): string {
    const value = path.hash ?? `${path.id}-${path.updatedAt.getTime()}-${path.size}`;
    return `"${value}"`;
}

// If-None-Match matcher: weak comparison (W/ stripped) is correct for GET/304 per RFC 7232 §3.2.
export function etagMatches(header: string, etag: string): boolean {
    if (header.trim() === '*') return true;
    return header
        .split(',')
        .map((s) => s.trim().replace(/^W\//, ''))
        .includes(etag);
}

// RFC 7232 If-Match matcher for DAV write seams (CalDAV/CardDAV) whose stored etag is a bare content
// hash the handler quotes only in the response. `*` means "the resource exists", so null never matches;
// §3.1 mandates STRONG comparison, so a member of the comma-list matches only after its quotes are
// stripped — a weak `W/` validator never matches. Callers 412 when If-Match is present and this is false.
export function matchesIfMatch(header: string, etag: string | null): boolean {
    if (header === '*') return etag !== null;
    if (etag === null) return false;
    return header.split(',').some((raw) => raw.trim().replace(/^"|"$/g, '') === etag);
}

// The If-None-Match counterpart: §3.2 weak comparison strips each member's `W/` prefix before the quote
// strip. `*` still means "the resource exists". Callers 412 when If-None-Match is present and this is true.
export function matchesIfNoneMatch(header: string, etag: string | null): boolean {
    if (header === '*') return etag !== null;
    if (etag === null) return false;
    return header.split(',').some((raw) => raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === etag);
}

// The bounded request-body reader every DAV router's XML/body seam sits on. Reads the body as UTF-8 text but
// refuses to buffer more than `maxBytes`: the Content-Length pre-check rejects an honest client early, and the
// read loop cancels the stream the instant the running total crosses the cap — the load-bearing check, since a
// chunked or Bun-string body carries no length header to trust. Returns the decoded text ('' for an empty
// body), or null when the cap is exceeded, leaving each caller to map null to its own rejection (WebDAV throws
// 413, CalDAV/CardDAV return an explicit 413) so a hostile payload never reaches the synchronous XML parser.
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
    const len = request.headers.get('Content-Length');
    if (len !== null && Number(len) > maxBytes) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    if (chunks.length === 0) return '';
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
}

// RFC 7233 single byte-range. Returns the inclusive [start, end] when satisfiable,
// 'unsatisfiable' when a range was requested but can't be served (caller responds 416),
// or null when there's no Range header (caller serves the full 200 body).
// Single source for the byte math shared by serveFile (embed/download) and the WebDAV GET.
export function parseByteRange(
    rangeHeader: string | null,
    size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
    if (!rangeHeader) return null;
    if (size === 0) return 'unsatisfiable';
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return 'unsatisfiable';
    const startStr = match[1];
    const endStr = match[2];
    // Suffix range "bytes=-N" means "last N bytes": start = size - N, end = size - 1.
    // Open-ended "bytes=N-" means "from N to EOF": end = size - 1.
    const start = startStr === '' ? Math.max(0, size - Number(endStr)) : Number(startStr);
    const end = endStr === '' || startStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
    if (start < 0 || start > end || start >= size) return 'unsatisfiable';
    return { start, end };
}

export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(fileName);
    if (ascii === fileName) {
        return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"`;
    }
    return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`;
}
