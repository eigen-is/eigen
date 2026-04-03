import { Elysia, t } from 'elysia';
import { verifyProtocolAuth } from '../lib/auth/protocol-auth';
import { requireLocalhost } from '../lib/core/access';

export const internalRouter = new Elysia({ name: 'internal' }).post(
    '/internal/auth/verify',
    async ({ body, request, server }) => {
        requireLocalhost(request, server);

        try {
            const user = await verifyProtocolAuth(body.email, body.password);
            return { userId: user.id, email: user.email };
        } catch {
            return new Response('Unauthorized', { status: 401 });
        }
    },
    {
        body: t.Object({
            email: t.String(),
            password: t.String(),
        }),
    },
);
