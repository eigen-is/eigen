import { Elysia } from 'elysia';
import { auth } from '../lib/auth/auth';
import { ApiError } from '../lib/core';

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
});
