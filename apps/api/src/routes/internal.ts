// The routes that other containers of the install call, not browsers or apps. The mail server checks a mail
// login against them, and the queue monitor reports a mail backlog. Both only answer to requests from the same
// machine.

import { Elysia, t } from 'elysia';
import { requireLocalhost } from '../lib/auth/access';
import { verifyProtocolAuth } from '../lib/auth/protocol-auth';
import { refuseShutHome } from '../lib/home';
import { alertOwner } from '../lib/user/alert-owner';

export const internalRouter = new Elysia({ name: 'internal' })
    .post(
        '/internal/auth/verify',
        async ({ body, request, server }) => {
            requireLocalhost(request, server);
            const user = await verifyProtocolAuth(body.email, body.password, body.ip);
            // After a yes Dovecot creates the Maildir's missing folders, which would remake a home that a restore or a
            // deletion is moving. The mail server takes this refusal as a temporary failure, so the client retries.
            refuseShutHome(user.id);
            return { userId: user.id, email: user.email };
        },
        {
            body: t.Object({
                email: t.String(),
                password: t.String(),
                // 45 is the longest zone-less IPv6 text form; the slack is room for a zone id.
                ip: t.Optional(t.String({ maxLength: 64 })),
            }),
        },
    )
    // The queue lives on the mail container's private volume, so the API can't count it and is told instead.
    .post(
        '/internal/mail/queue-alert',
        async ({ body, request, server }) => {
            requireLocalhost(request, server);
            return {
                notified: await alertOwner(
                    'Mail queue backlog',
                    `${body.queued} messages queued`,
                    'mail-queue-backlog',
                ),
            };
        },
        {
            body: t.Object({
                queued: t.Integer({ minimum: 0 }),
            }),
        },
    );
