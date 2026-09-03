import { Elysia, sse } from 'elysia';
import { requireSelf } from '../lib/core/access';
import { createSSEStream, getHome } from '../lib/home';
import { betterAuth } from './auth';

// SSE is personal-only — each user subscribes to their own Home's event stream.
// X-Accel-Buffering: no defends against reverse proxies (nginx, Cloudflare) that buffer by
// default — without it, events stack up in the proxy until the connection closes.
export const sseRouter = new Elysia({ name: 'sse' }).use(betterAuth).get(
    '/sse/:ownerId/events',
    async ({ params, user, set }) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id);
        set.headers['X-Accel-Buffering'] = 'no';
        return sse(createSSEStream(home));
    },
    { auth: true },
);
