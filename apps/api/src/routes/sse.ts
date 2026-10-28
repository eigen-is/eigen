// The route that opens the live event stream of a user's own Home. The app listens to it for changes made elsewhere,
// such as new mail or a file that someone else edited, so the screen stays current without a refresh.

import { Elysia, sse } from 'elysia';
import { requireSelf } from '../lib/auth/access';
import { createSSEStream, getHome } from '../lib/home';
import { betterAuth } from './auth';

export const sseRouter = new Elysia({ name: 'sse' }).use(betterAuth).get(
    '/sse/:ownerId/events',
    async ({ params, user, set }) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id);
        // A reverse proxy such as nginx buffers a response by default, and would hold the events until
        // the stream closes. This header turns that off.
        set.headers['X-Accel-Buffering'] = 'no';
        return sse(createSSEStream(home));
    },
    { auth: true },
);
