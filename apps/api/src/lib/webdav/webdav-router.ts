import Elysia from 'elysia';
import { authenticateBasic } from './auth';
import { handleDiscoveryOwner, handleDiscoveryRoot } from './discovery';

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
    });
