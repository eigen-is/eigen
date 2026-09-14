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

// The bounded request-body reader every DAV router's XML/body seam sits on. The Content-Length pre-check only
// rejects an honest client early; the read loop's own cap is load-bearing, since a chunked or Bun-string body
// carries no trustworthy length. null means the cap was exceeded, and each caller maps it to its rejection.
export async function readBoundedBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
    const len = request.headers.get('Content-Length');
    if (len !== null && Number(len) > maxBytes) return null;
    if (!request.body) return new Uint8Array();
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
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return merged;
}

// Lenient UTF-8 decode, which is what an XML body wants; a caller holding a user's file decodes it itself.
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
    const bytes = await readBoundedBodyBytes(request, maxBytes);
    return bytes === null ? null : new TextDecoder().decode(bytes);
}

// RFC 7233 single byte-range. Returns the inclusive [start, end] when satisfiable,
// 'unsatisfiable' when a parsed range lies outside the resource (caller responds 416),
// or null when there is no range to serve (caller serves the full 200 body).
export function parseByteRange(
    rangeHeader: string | null,
    size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
    if (!rangeHeader) return null;
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    // §3.1: a Range we can't parse — a multi-range list, stray whitespace, another unit — is ignored,
    // not rejected. Only a range we did parse and cannot serve is a 416.
    if (!match) return null;
    const startStr = match[1];
    const endStr = match[2];
    if (startStr === '' && endStr === '') return null;
    // A last-pos before its first-pos is an invalid spec, which also means "ignore" (RFC 9110 §14.1.1).
    if (startStr !== '' && endStr !== '' && Number(startStr) > Number(endStr)) return null;
    if (size === 0) return 'unsatisfiable';
    // Suffix range "bytes=-N" means "last N bytes": start = size - N, end = size - 1.
    // Open-ended "bytes=N-" means "from N to EOF": end = size - 1.
    const start = startStr === '' ? Math.max(0, size - Number(endStr)) : Number(startStr);
    const end = endStr === '' || startStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
    if (start < 0 || start > end || start >= size) return 'unsatisfiable';
    return { start, end };
}

// The RFC 7233 response shape the byte-range servers share. Callers own their headers and ETag/304 handling
// and pass only the byte source; `end` is exclusive because every reader takes it that way. Content-Length
// only binds for an in-memory body: Bun derives it from a BunFile and sends a stream chunked.
export async function rangeResponse(
    headers: Record<string, string>,
    size: number,
    range: string | null,
    source: {
        slice: (start: number, end: number) => BodyInit | Promise<BodyInit>;
        full: () => BodyInit | Promise<BodyInit>;
    },
): Promise<Response> {
    const parsed = parseByteRange(range, size);
    if (parsed === 'unsatisfiable') {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    if (parsed) {
        return new Response(await source.slice(parsed.start, parsed.end + 1), {
            status: 206,
            headers: {
                ...headers,
                'Content-Length': String(parsed.end - parsed.start + 1),
                'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}`,
            },
        });
    }
    return new Response(await source.full(), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(fileName);
    if (ascii === fileName) {
        return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"`;
    }
    return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`;
}

// An uploaded HTML/SVG/XML served INLINE from the API's own origin could run script with the viewer's
// session: the sandbox CSP neutralises active content while still rendering the file, and nosniff stops the
// browser re-sniffing a disguised payload. Empty for other types, so callers spread it unconditionally.
export function scriptableInlineHeaders(mimeType: string): Record<string, string> {
    const baseMime = mimeType.split(';')[0].trim().toLowerCase();
    // Every XML flavor scripts too: an `<?xml-stylesheet?>` PI runs XSLT. The `+xml` suffix already
    // covers image/svg+xml and application/xhtml+xml, so neither needs an entry of its own.
    const isXml = baseMime === 'text/xml' || baseMime === 'application/xml' || baseMime.endsWith('+xml');
    if (baseMime === 'text/html' || isXml) {
        return { 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' };
    }
    return {};
}
