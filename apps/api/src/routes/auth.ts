// Mounts better-auth's own HTTP routes under /auth and gives every other router the `auth` macro, which turns the
// session cookie into the signed-in user or answers 401. The few routes a public link opens use `linkAuth`, which
// goes on without a user. A guard in front of the mount refuses self sign-up, and in demo mode the auth calls a
// visitor must not make.

import { Elysia } from 'elysia';
import { auth } from '../lib/auth/auth';
import { isDemo } from '../lib/config/env';
import { ApiError } from '../lib/core';

// The auth calls a demo visitor must not make. An app password is a live mail and DAV credential, turning on 2FA
// takes a persona out of the pool, and revoking sessions signs out the other visitors on that persona.
const DEMO_BLOCKED_AUTH_PATHS = new Set([
    '/auth/api-key/create',
    '/auth/api-key/update',
    '/auth/api-key/delete',
    '/auth/two-factor/enable',
    '/auth/revoke-sessions',
    '/auth/revoke-other-sessions',
]);

// What an answer without a login carries: a public link is no page for a search engine, and a shared computer's cache
// must not keep what the link showed after it is closed.
const VISITOR_HEADERS = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' };

// The guard is chained before `.mount(auth.handler)`: Elysia snapshots an instance's lifecycle hooks at route
// registration, so a hook added after the mount never runs for the mounted handler.
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
                const session = await auth.api.getSession({ headers });

                if (!session) {
                    throw new ApiError(401, 'Unauthorized');
                }

                return { user: session.user, session: session.session };
            },
        },
        optionalAuth: {
            async resolve({ request: { headers } }) {
                const session = await auth.api.getSession({ headers });

                return { user: session?.user ?? null, session: session?.session ?? null };
            },
        },
    })
    // Its own macro call, because a macro's hook reads only what a macro it builds on resolved.
    .macro('linkAuth', {
        optionalAuth: true,
        // A returned Response carries its own headers, which those on `set` don't replace.
        afterHandle({ user, set, responseValue }) {
            if (user) return;
            Object.assign(set.headers, VISITOR_HEADERS);
            if (responseValue instanceof Response) {
                for (const [name, value] of Object.entries(VISITOR_HEADERS)) responseValue.headers.set(name, value);
            }
        },
    });
