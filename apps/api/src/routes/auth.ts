import { Elysia } from 'elysia';
import { auth } from '../lib/auth/auth';
import { isDemo } from '../lib/config/env';
import { getServerSettings } from '../lib/config/server-settings';
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
        // better-auth mounts POST /auth/sign-up/email with no gate of its own; the product onboards
        // through invites, the waitlist and admin user creation, so self-registration is off by default.
        // Server-side auth.api.signUpEmail calls (setup, tests) don't pass through this hook, so they
        // keep working — not better-auth's disableSignUp, which would break those too.
        if (path === '/auth/sign-up/email' && !getServerSettings().onboarding.openSignup) {
            throw new ApiError(403, 'Sign-up is disabled');
        }
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
