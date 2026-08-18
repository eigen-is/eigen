import Elysia from 'elysia';
import { authenticateBasic } from '../auth/protocol-auth';
import { ApiError } from '../core/errors';
import { readBoundedBody } from '../core/http';
import { handleLock, handleUnlock } from './locks';
import { handleCopy, handleMove } from './move-copy';
import { handleResourcePropfind } from './propfind';
import { handleProppatch } from './proppatch';
import { handleDelete, handleGet, handleMkcol, handlePut } from './resource';
import { decodeHref } from './xml';

// Default-to-`infinity` matches RFC 4918: when Depth is omitted, it defaults to infinity.
// handleResourcePropfind then returns 403 with propfind-finite-depth, which is correct.
function parseDepth(header: string | null): '0' | '1' | 'infinity' {
    if (header === '0') return '0';
    if (header === '1') return '1';
    return 'infinity';
}

// Elysia leaves wildcard params percent-encoded ("My%20Folder/file.txt"); decode
// per-segment so a real space in a name matches the row stored as "My Folder".
// Trailing slashes are stripped so /foo/ and /foo resolve to the same row — most
// clients append `/` to collection URLs, but the underlying path has no slash.
function pathStrFromParams(star: string | undefined): string {
    const rest = (star ?? '').replace(/\/+$/, '');
    return rest.length === 0 ? '/' : `/${decodeHref(rest)}`;
}

// PROPFIND/PROPPATCH/LOCK bodies are short XML in any real client. Reject anything bigger up front (via the
// shared bounded reader) so an authenticated user can't park megabytes of input on fast-xml-parser's
// synchronous path; over-limit is a 413, WebDAV's long-standing behavior.
const MAX_XML_BODY_BYTES = 65_536;

async function readXmlBody(request: Request): Promise<string> {
    const body = await readBoundedBody(request, MAX_XML_BODY_BYTES);
    if (body === null) throw new ApiError(413, 'Payload Too Large');
    return body;
}

// The mount URL is /webdav/<ownerId>/<mountId>/. Levels above (/webdav/, /webdav/<ownerId>/)
// are intentionally not exposed: there is no auto-discovery API, and any client that
// navigates "up" from a mounted URL gets 404. Each accessible mount's URL is listed in
// the Space services page (apps/space/src/routes/_auth.services.tsx) for users to copy.
export const webdavRouter = new Elysia({ name: 'webdav', prefix: '/webdav' })
    .route('PROPFIND', '/:ownerId/:mountId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const depth = parseDepth(request.headers.get('Depth'));
        return handleResourcePropfind({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: '/',
            depth,
            body: await readXmlBody(request),
        });
    })
    .route('PROPFIND', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const depth = parseDepth(request.headers.get('Depth'));
        return handleResourcePropfind({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            depth,
            body: await readXmlBody(request),
        });
    })
    .route('GET', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleGet({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            headOnly: false,
            rangeHeader: request.headers.get('Range'),
            ifMatch: request.headers.get('If-Match'),
            ifNoneMatch: request.headers.get('If-None-Match'),
        });
    })
    .route('HEAD', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleGet({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            headOnly: true,
            rangeHeader: null,
            ifMatch: request.headers.get('If-Match'),
            ifNoneMatch: request.headers.get('If-None-Match'),
        });
    })
    .route('PUT', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const len = request.headers.get('Content-Length');
        return handlePut({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            body: request.body,
            contentLength: len ? Number(len) : null,
            ifMatch: request.headers.get('If-Match'),
            ifNoneMatch: request.headers.get('If-None-Match'),
            ifHeader: request.headers.get('If'),
        });
    })
    .route('MKCOL', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const len = Number(request.headers.get('Content-Length') ?? 0);
        return handleMkcol({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            contentLength: len,
            ifHeader: request.headers.get('If'),
        });
    })
    .route('DELETE', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleDelete({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            ifHeader: request.headers.get('If'),
        });
    })
    .route('MOVE', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleMove({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            requestUrl: request.url,
            destinationHeader: request.headers.get('Destination'),
            overwrite: (request.headers.get('Overwrite') ?? 'T').toUpperCase() !== 'F',
            ifHeader: request.headers.get('If'),
        });
    })
    .route('COPY', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleCopy({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            requestUrl: request.url,
            destinationHeader: request.headers.get('Destination'),
            overwrite: (request.headers.get('Overwrite') ?? 'T').toUpperCase() !== 'F',
            ifHeader: request.headers.get('If'),
            depth: parseDepth(request.headers.get('Depth')),
        });
    })
    .route('PROPPATCH', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleProppatch({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            body: await readXmlBody(request),
            ifHeader: request.headers.get('If'),
        });
    })
    .route('LOCK', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleLock({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            body: await readXmlBody(request),
            timeoutHeader: request.headers.get('Timeout'),
            ifHeader: request.headers.get('If'),
            depthHeader: request.headers.get('Depth'),
        });
    })
    .route('UNLOCK', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleUnlock({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: pathStrFromParams(params['*']),
            lockTokenHeader: request.headers.get('Lock-Token'),
        });
    });
