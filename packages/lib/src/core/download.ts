// Saving a response to the user's disk. Browser-only (it needs `document` and `URL.createObjectURL`),
// so the backend never imports this module.

export function downloadBlob(blob: Blob, filename: string): void {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
}

// RFC 6266: `filename*` carries the real, percent-encoded name and wins over the ASCII-only `filename`
// our server sends beside it (contentDisposition writes both when the name has non-ASCII characters).
export function filenameFromDisposition(header: string | null, fallback: string): string {
    if (!header) return fallback;
    const extended = header.match(/filename\*=[^']*'[^']*'([^;]+)/i);
    if (extended) return decodeURIComponent(extended[1].trim());
    const plain = header.match(/filename="([^"]*)"|filename=([^;]+)/i);
    return plain?.[1] || plain?.[2]?.trim() || fallback;
}

// Saving a URL the server already serves with a filename: `download = ''` leaves the name to
// Content-Disposition (production is same-origin, where the attribute would otherwise win). Pass
// `filename` only where the caller knows a better name than the server sends.
export function triggerDownload(url: string, filename?: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}
