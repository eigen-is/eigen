import { ApiError } from '../core/errors';

// Finder sends NFD-decomposed UTF-8; encode each segment via encodeURIComponent
// then rejoin with '/' so multi-byte chars round-trip while keeping path separators.
export function encodeHref(path: string): string {
    return path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
}

// Inverse of encodeHref; Elysia's wildcard params and URL.pathname both keep the percent-encoding.
export function decodeHref(path: string): string {
    try {
        return path
            .split('/')
            .map((seg) => decodeURIComponent(seg))
            .join('/');
    } catch {
        throw new ApiError(400, 'Malformed percent-encoding in path');
    }
}

// The parent path and the NFC leaf name of a client path.
export function splitParentAndName(pathStr: string): { parentStr: string; name: string } {
    const lastSlash = pathStr.lastIndexOf('/');
    return { parentStr: pathStr.slice(0, lastSlash) || '/', name: pathStr.slice(lastSlash + 1).normalize('NFC') };
}
