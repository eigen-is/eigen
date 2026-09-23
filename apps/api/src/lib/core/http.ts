import type { DrivePath } from '@workspace/lib/types/drive';
import { type ElysiaCustomStatusResponse, status } from 'elysia';
import { ApiError } from './errors';

// Default private: these bodies are per-user, and 'public' is reserved for the unauthenticated /p/ surface.
export function setCacheHeaders(
    set: { headers: Record<string, string | number> },
    maxAgeSeconds: number,
    visibility: 'private' | 'public' = 'private',
): void {
    set.headers['Cache-Control'] = `${visibility}, max-age=${maxAgeSeconds}`;
}

// A row without a SHA-256 hash falls back to a synthetic id+mtime+size triple; the quotes are RFC 7232's.
export function computeEtag(path: Pick<DrivePath, 'hash' | 'id' | 'updatedAt' | 'size'>): string {
    const value = path.hash ?? `${path.id}-${path.updatedAt.getTime()}-${path.size}`;
    return `"${value}"`;
}

// The validator is stamped only once the body exists: an error answered with it would be stored, and every later 304 would resurrect that error.
export async function answerRevalidated<T>(
    request: Request,
    set: { headers: Record<string, string | number> },
    etag: string,
    produce: () => Promise<T>,
): Promise<T | ElysiaCustomStatusResponse<304>> {
    const ifNoneMatch = request.headers.get('if-none-match');
    const body = ifNoneMatch !== null && matchesIfNoneMatch(ifNoneMatch, etag) ? status(304) : await produce();
    set.headers['Cache-Control'] = 'private, no-cache';
    set.headers['ETag'] = etag;
    return body;
}

// The renderer's format tag rides in the ETag, so a payload or sanitizer fix answers with the new body, not a 304.
export async function answerPreview<T>(
    request: Request,
    set: { headers: Record<string, string | number> },
    path: Pick<DrivePath, 'hash' | 'id' | 'updatedAt' | 'size'>,
    format: string,
    generate: () => Promise<{ value: T; stale: boolean } | null>,
): Promise<T | ElysiaCustomStatusResponse<304>> {
    let stale = false;
    const body = await answerRevalidated(request, set, `${computeEtag(path).slice(0, -1)}-${format}"`, async () => {
        const result = await generate();
        if (!result) throw new ApiError(404, 'No preview available');
        stale = result.stale;
        return result.value;
    });
    // Stale-while-revalidate: the previous version, served while the current one regenerates, is never stored by a browser.
    if (stale) set.headers['Cache-Control'] = 'no-store';
    return body;
}

// RFC 7232 §3.1 mandates STRONG comparison: the quotes are part of the tag, so a weak `W/` validator never matches.
export function matchesIfMatch(header: string, etag: string | null): boolean {
    if (header.trim() === '*') return etag !== null;
    if (etag === null) return false;
    return header.split(',').some((raw) => raw.trim() === etag);
}

// RFC 7232 §3.2 compares weakly, so each member's `W/` prefix comes off first.
export function matchesIfNoneMatch(header: string, etag: string | null): boolean {
    if (header.trim() === '*') return etag !== null;
    if (etag === null) return false;
    return header.split(',').some((raw) => raw.trim().replace(/^W\//, '') === etag);
}

// The Content-Length pre-check only rejects an honest client early: a chunked body carries no trustworthy length, so the loop's cap is the real one.
export async function readBoundedBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
    const len = request.headers.get('Content-Length');
    if (len !== null && Number(len) > maxBytes) return null;
    if (!request.body) return new Uint8Array();
    return readBoundedStreamBytes(request.body, maxBytes);
}

// Also over a stored file, whose recorded size may be stale; null means the cap was exceeded and the stream is cancelled.
export async function readBoundedStreamBytes(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
): Promise<Uint8Array | null> {
    const reader = stream.getReader();
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

// RFC 7233 single byte-range: 'unsatisfiable' is the caller's 416, null its full 200 body.
export function parseByteRange(
    rangeHeader: string | null,
    size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
    if (!rangeHeader) return null;
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    // §3.1: an unparseable Range is ignored, not rejected; only a parsed range we cannot serve is a 416.
    if (!match) return null;
    const startStr = match[1];
    const endStr = match[2];
    if (startStr === '' && endStr === '') return null;
    // A last-pos before its first-pos is an invalid spec, which also means "ignore" (RFC 9110 §14.1.1).
    if (startStr !== '' && endStr !== '' && Number(startStr) > Number(endStr)) return null;
    if (size === 0) return 'unsatisfiable';
    // "bytes=-N" is the last N bytes, "bytes=N-" runs to EOF.
    const start = startStr === '' ? Math.max(0, size - Number(endStr)) : Number(startStr);
    const end = endStr === '' || startStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
    if (start < 0 || start > end || start >= size) return 'unsatisfiable';
    return { start, end };
}

// Content-Length only binds for an in-memory body: Bun derives it from a BunFile and sends a stream chunked.
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
    // A client writes this name to disk: no separator or control character survives, and a clamped name may end in a lone surrogate.
    const name =
        fileName
            .toWellFormed()
            .replace(/[/\\]|\p{Cc}/gu, '_')
            .replace(/^\.+$/, '') || 'download';
    const ascii = name.replace(/[^\x20-\x7E]/g, '_');
    if (ascii === name) {
        return `${type}; filename="${ascii.replace(/"/g, '_')}"`;
    }
    return `${type}; filename="${ascii.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Inline HTML/SVG/XML from the API's own origin could run script with the viewer's session: the sandbox CSP neutralises it, nosniff stops re-sniffing.
export function scriptableInlineHeaders(mimeType: string): Record<string, string> {
    const baseMime = mimeType.split(';')[0].trim().toLowerCase();
    // An `<?xml-stylesheet?>` PI runs XSLT, so every XML flavor scripts too; `+xml` already covers svg and xhtml.
    const isXml = baseMime === 'text/xml' || baseMime === 'application/xml' || baseMime.endsWith('+xml');
    if (baseMime === 'text/html' || isXml) {
        return { 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff' };
    }
    return {};
}
