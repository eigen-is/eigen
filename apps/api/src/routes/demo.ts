import { Elysia } from 'elysia';
import { getDemoPersonaPool } from '../lib/auth/demo-persona-pool';
import { signInWithScopedPassword } from '../lib/auth/guest-auth';
import { isDemo } from '../lib/config/env';
import { getServerConfig } from '../lib/config/server-config';
import { clientIpKey } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';
import { WindowLimiter } from '../lib/core/window-limiter';

// Each entry runs two scrypt ops, so the loose global limiter isn't tight enough: 10 a minute per
// client IP, which Caddy sets in X-Real-IP, so the key isn't spoofable.
const entryLimiter = new WindowLimiter(60 * 1000, 10);

// The /p/ prefix is eigen's PUBLIC API surface — intentionally unauthenticated. Do NOT add
// `auth: true` / `.use(betterAuth)` (see routes/public.ts). The route is registered at startup;
// isDemo() is the runtime gate, so on real instances it 404s and is inert.
export const demoRouter = new Elysia({ name: 'demo' }).get('/p/demo/enter', async ({ set, request, server }) => {
    if (!isDemo()) throw new ApiError(404, 'Not found');

    if (!entryLimiter.take(clientIpKey(request, server))) {
        throw new ApiError(429, 'Too many requests from this network — try again later');
    }

    const orgId = getServerConfig()?.orgId;
    if (!orgId) throw new ApiError(503, 'Demo not available');

    const pool = getDemoPersonaPool(orgId);
    if (pool.length === 0) throw new ApiError(503, 'Demo not available');

    const persona = pool[Math.floor(Math.random() * pool.length)]!;
    const response = await signInWithScopedPassword('demo', persona.id, persona.email);

    // getSetCookie keeps multiple Set-Cookie headers distinct (get() would comma-join them).
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) set.headers['set-cookie'] = cookies;
    set.status = 302;
    set.headers.location = '/space';
});
