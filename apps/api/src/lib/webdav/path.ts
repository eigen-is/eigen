// The WebDAV handlers' URL paths: what a request names and what an answer's hrefs name. A request path is
// decoded and split here before it is resolved in the drive, and a multistatus answer, such as PROPFIND's, builds
// its hrefs with mountHref, under the base path the public proxy serves the API at.

import { getApiBasePath } from '../config/env';
import { ApiError } from '../core/errors';

// Each segment is encoded on its own, so a multi-byte name such as Finder's NFD round-trips and the slashes stay.
export function encodeHref(path: string): string {
    return path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
}

// Elysia's wildcard params and URL.pathname both keep the percent-encoding.
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

// The proxy strips its base path from the request line, so the client reaches a mount only at an href that has it.
export function mountHref(ownerId: string, mountId: string): string {
    return `${getApiBasePath()}/webdav/${encodeHref(ownerId)}/${encodeHref(mountId)}`;
}

// The parent path and the NFC leaf name of a client path.
export function splitParentAndName(pathStr: string): { parentStr: string; name: string } {
    const lastSlash = pathStr.lastIndexOf('/');
    return { parentStr: pathStr.slice(0, lastSlash) || '/', name: pathStr.slice(lastSlash + 1).normalize('NFC') };
}
