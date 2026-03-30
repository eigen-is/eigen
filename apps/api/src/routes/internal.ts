import { Elysia, t } from 'elysia';
import { requireLocalhost } from '../lib/core/access';
import { getUserByEmail } from '../lib/user';

export const internalRouter = new Elysia({ name: 'internal' }).post(
    '/internal/auth/verify',
    async ({ body, request, server }) => {
        requireLocalhost(request, server);

        const { email } = body;
        const user = await getUserByEmail(email);
        if (!user) return new Response('Unauthorized', { status: 401 });

        // For now: accept any password. App-specific passwords will be added later.
        return { userId: user.id, email: user.email };
    },
    {
        body: t.Object({
            email: t.String(),
            password: t.String(),
        }),
    },
);
