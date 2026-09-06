import { Elysia } from 'elysia';
import { auth } from '../lib/auth/auth';
import { isDemo } from '../lib/config/env';
import { ApiError } from '../lib/core';

// Auth mutations a demo visitor must not reach: api keys are live IMAP/CalDAV/WebDAV credentials,
// 2FA enrollment would lock a persona out of the pool, revoke-sessions griefs other visitors.
const DEMO_BLOCKED_AUTH_PATHS = new Set([
    '/auth/api-key/create',
    '/auth/api-key/update',
    '/auth/api-key/delete',
    '/auth/two-factor/enable',
    '/auth/revoke-sessions',
    '/auth/revoke-other-sessions',
]);

// user middleware (compute user and session and pass to routes)
// This guard MUST be chained before `.mount(auth.handler)`: Elysia snapshots an instance's
// lifecycle hooks at route registration, so a hook added after `.mount()` never runs for the
// mounted handler.
export const betterAuth = new Elysia({ name: 'better-auth' })
    .onBeforeHandle(({ request }) => {
        const path = new URL(request.url).pathname;
        // Self-registration is off: onboarding runs through invites, the waitlist and admin user creation.
        // Server-side auth.api.signUpEmail (setup, tests) doesn't pass through this hook and keeps working.
        if (path === '/auth/sign-up/email') throw new ApiError(403, 'Sign-up is disabled');
        if (isDemo() && DEMO_BLOCKED_AUTH_PATHS.has(path)) throw new ApiError(403, 'Disabled in demo mode');
    })
    .mount(auth.handler)
    .macro({
        auth: {
            async resolve({ request: { headers } }) {
                const session = await auth.api.getSession({
                    headers,
                });

                if (!session) {
                    throw new ApiError(401, 'Unauthorized');
                }

                return {
                    user: session.user,
                    session: session.session,
                };
            },
        },
    });
