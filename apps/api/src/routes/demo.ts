import { and, eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { member, user } from '../../auth-schema.ts';
import { getAuthDrizzleDb } from '../lib/auth/auth';
import { signInWithScopedPassword } from '../lib/auth/guest-auth';
import { isDemo } from '../lib/config/env';
import { getServerConfig } from '../lib/config/server-config';
import { ApiError } from '../lib/core/errors';

// The /p/ prefix is eigen's PUBLIC API surface — intentionally unauthenticated. Do NOT add
// `auth: true` / `.use(betterAuth)` (see routes/public.ts). The route is registered at startup;
// isDemo() is the runtime gate, so on real instances it 404s and is inert.
export const demoRouter = new Elysia({ name: 'demo' }).get('/p/demo/enter', async ({ set }) => {
    if (!isDemo()) throw new ApiError(404, 'Not found');

    const orgId = getServerConfig()?.orgId;
    if (!orgId) throw new ApiError(503, 'Demo not available');

    // Discover the pool from org membership so it can't drift from the seeder. role='member'
    // excludes the setup admin (org 'owner'), keeping the admin surface out of a visitor's reach.
    const pool = getAuthDrizzleDb()
        .select({ id: user.id, email: user.email })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(eq(member.organizationId, orgId), eq(member.role, 'member')))
        .all();
    if (pool.length === 0) throw new ApiError(503, 'Demo not available');

    const persona = pool[Math.floor(Math.random() * pool.length)]!;
    const response = await signInWithScopedPassword('demo', persona.id, persona.email);

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) set.headers['set-cookie'] = setCookie;
    set.status = 302;
    set.headers.location = '/space';
});
