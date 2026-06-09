export function setCacheHeaders(set: { headers: Record<string, string | number> }, maxAgeSeconds: number): void {
    set.headers['Cache-Control'] = `public, max-age=${maxAgeSeconds}`;
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
