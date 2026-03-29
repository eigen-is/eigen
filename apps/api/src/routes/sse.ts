import { Elysia, sse } from 'elysia';
import { requireSelf } from '../lib/core/access';
import { getHome } from '../lib/home';
import { betterAuth } from './auth';

// SSE is personal-only — each user subscribes to their own Home's event stream.
export const sseRouter = new Elysia({ name: 'sse' }).use(betterAuth).get(
    '/sse/:ownerId/events',
    async ({ params, user }) => {
        requireSelf(params.ownerId, user.id);
        const home = await getHome(user.id);
        return sse(home.createSSEStream(getHome));
    },
    { auth: true },
);
