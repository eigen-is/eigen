import Elysia from 'elysia';
import { authenticateBasic } from './auth';

// Routes are filled in by later tasks. This catch-all wires Basic-auth into the
// /webdav prefix so unauthenticated requests get a proper 401 challenge before
// the real PROPFIND/PUT/etc. handlers exist.
export const webdavRouter = new Elysia({ name: 'webdav', prefix: '/webdav' }).route(
    'PROPFIND',
    '/*',
    async ({ request }) => {
        await authenticateBasic(request);
        return new Response('Not Found', { status: 404 });
    },
);
