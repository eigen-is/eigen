import { Elysia } from 'elysia';
import { getDemoPersonaPool } from '../lib/auth/demo-persona-pool';
import { checkDemoRateLimit } from '../lib/auth/demo-rate-limit';
import { signInWithScopedPassword } from '../lib/auth/guest-auth';
import { isDemo } from '../lib/config/env';
import { getServerConfig } from '../lib/config/server-config';
import { clientIpKey } from '../lib/core/access';
import { ApiError } from '../lib/core/errors';

// The /p/ prefix is eigen's PUBLIC API surface — intentionally unauthenticated. Do NOT add
// `auth: true` / `.use(betterAuth)` (see routes/public.ts). The route is registered at startup;
// isDemo() is the runtime gate, so on real instances it 404s and is inert.
export const demoRouter = new Elysia({ name: 'demo' }).get('/p/demo/enter', async ({ set, request, server }) => {
    if (!isDemo()) throw new ApiError(404, 'Not found');

    // Tight per-IP cap before the scrypt work below — this route is unauthenticated.
    checkDemoRateLimit(clientIpKey(request, server));

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
