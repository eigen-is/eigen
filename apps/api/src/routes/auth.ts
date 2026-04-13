import { Elysia } from 'elysia';
import { auth } from '../lib/auth/auth';
import { ApiError } from '../lib/core';
import { requireNonGuest } from '../lib/core/access';

// user middleware (compute user and session and pass to routes)
export const betterAuth = new Elysia({ name: 'better-auth' }).mount(auth.handler).macro({
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
    // When set to true, blocks guest users from accessing the route.
    // Must be used together with auth: true so that user is resolved first.
    noGuest: {
        beforeHandle({ user }: { user: { role?: string | null }; [k: string]: unknown }) {
            requireNonGuest(user);
        },
    },
});
