import Elysia from 'elysia';
import { authenticateBasic } from './auth';
import { handleDiscoveryOwner, handleDiscoveryRoot } from './discovery';
import { handleCopy, handleMove } from './move-copy';
import { handleResourcePropfind } from './propfind';
import { handleProppatch } from './proppatch';
import { handleDelete, handleGet, handleMkcol, handlePut } from './resource';

// Default-to-`infinity` matches RFC 4918: when Depth is omitted, it defaults to infinity.
// handleResourcePropfind then returns 403 with propfind-finite-depth, which is correct.
function parseDepth(header: string | null): '0' | '1' | 'infinity' {
    if (header === '0') return '0';
    if (header === '1') return '1';
    return 'infinity';
}

export const webdavRouter = new Elysia({ name: 'webdav', prefix: '/webdav' })
    .route('PROPFIND', '/', async ({ request }) => {
        const user = await authenticateBasic(request);
        return handleDiscoveryRoot(user);
    })
    .route('PROPFIND', '/:ownerId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleDiscoveryOwner(user, params.ownerId);
    })
    .route('PROPFIND', '/:ownerId/', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleDiscoveryOwner(user, params.ownerId);
    })
    .route('PROPFIND', '/:ownerId/:mountId', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const depth = parseDepth(request.headers.get('Depth'));
        return handleResourcePropfind({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: '/',
            depth,
        });
    })
    .route('PROPFIND', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const depth = parseDepth(request.headers.get('Depth'));
        const rest = (params['*'] ?? '').replace(/\/+$/, '');
        const pathStr = rest.length === 0 ? '/' : `/${rest}`;
        return handleResourcePropfind({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr,
            depth,
        });
    })
    .route('GET', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleGet({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
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
            pathStr: `/${params['*'] ?? ''}`,
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
            pathStr: `/${params['*'] ?? ''}`,
            body: request.body,
            contentLength: len ? Number(len) : null,
            ifMatch: request.headers.get('If-Match'),
            ifNoneMatch: request.headers.get('If-None-Match'),
        });
    })
    .route('MKCOL', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        const len = Number(request.headers.get('Content-Length') ?? 0);
        return handleMkcol({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
            contentLength: len,
        });
    })
    .route('DELETE', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleDelete({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
        });
    })
    .route('MOVE', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleMove({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
            requestUrl: request.url,
            destinationHeader: request.headers.get('Destination'),
            overwrite: (request.headers.get('Overwrite') ?? 'T').toUpperCase() !== 'F',
        });
    })
    .route('COPY', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleCopy({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
            requestUrl: request.url,
            destinationHeader: request.headers.get('Destination'),
            overwrite: (request.headers.get('Overwrite') ?? 'T').toUpperCase() !== 'F',
        });
    })
    .route('PROPPATCH', '/:ownerId/:mountId/*', async ({ request, params }) => {
        const user = await authenticateBasic(request);
        return handleProppatch({
            user,
            ownerId: params.ownerId,
            mountId: params.mountId,
            pathStr: `/${params['*'] ?? ''}`,
            body: await request.text(),
        });
    });
