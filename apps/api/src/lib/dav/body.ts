import { ApiError } from '../core/errors';
import { readBoundedBodyBytes } from '../core/http';

// One ceiling for every XML request body CalDAV and CardDAV read (PROPFIND, REPORT, MKCALENDAR, PROPPATCH): each is a
// small prop list or href list. WebDAV passes its own.
export const DAV_BODY_MAX_BYTES = 1_048_576;

// Bounded before it reaches a parser, which holds about 100× its input.
export async function readDavBody(request: Request, maxBytes: number): Promise<Uint8Array> {
    const body = await readBoundedBodyBytes(request, maxBytes);
    if (body === null) throw new ApiError(413, 'Payload Too Large');
    return body;
}
