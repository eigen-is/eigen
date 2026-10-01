import { Elysia, t } from 'elysia';
import { verifyProtocolAuth } from '../lib/auth/protocol-auth';
import { requireLocalhost } from '../lib/core/access';
import { alertOwner } from '../lib/user/alert-owner';

export const internalRouter = new Elysia({ name: 'internal' })
    .post(
        '/internal/auth/verify',
        async ({ body, request, server }) => {
            requireLocalhost(request, server);
            // `ip` is the mail client's address, forwarded by eigen-checkpassword from dovecot's
            // `TCPREMOTEIP`. Without it the limiter only ever sees the docker bridge peer.
            const user = await verifyProtocolAuth(body.email, body.password, body.ip);
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
    // Queue-backlog alert from the postfix container's queue-monitor.sh: the queue lives on a
    // private volume, so the API can't count it. A notification and not mail, because mail about a
    // jammed queue would sit in that queue.
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
