// Saving a response to the user's disk. Browser-only (it needs `document` and `URL.createObjectURL`),
// so the backend never imports this module.

import { useCallback, useState } from 'react';
import { onMutationError } from './api-error';

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

// A download the browser cannot do from an `<a href>` alone — the response's own Content-Disposition
// names the file, and a POST carries the selection. There is no mutation to carry a failure, so this
// reports its own; the flag drives the caller's spinner.
export function useFileDownload(): {
    download: (url: string, fallbackName: string, init?: RequestInit) => Promise<void>;
    isDownloading: boolean;
} {
    const [isDownloading, setIsDownloading] = useState(false);

    const download = useCallback(async (url: string, fallbackName: string, init?: RequestInit) => {
        setIsDownloading(true);
        try {
            const response = await fetch(url, { ...init, credentials: 'include' });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `Download failed (${response.status})`);
            }
            const blob = await response.blob();
            downloadBlob(blob, filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackName));
        } catch (e) {
            onMutationError(e);
        } finally {
            setIsDownloading(false);
        }
    }, []);

    return { download, isDownloading };
}

// `download = ''` leaves the name to Content-Disposition (production is same-origin, where the
// attribute would otherwise win).
export function triggerDownload(url: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
}
