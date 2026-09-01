import { Elysia, t } from 'elysia';
import { verifyProtocolAuth } from '../lib/auth/protocol-auth';
import { requireLocalhost } from '../lib/core/access';
import { sendToHome } from '../lib/home/home-relay';
import { getOrgOwner } from '../lib/user';

export const internalRouter = new Elysia({ name: 'internal' })
    .post(
        '/internal/auth/verify',
        async ({ body, request, server }) => {
            requireLocalhost(request, server);
            // `ip` is the mail client's address, forwarded by eigen-checkpassword from dovecot's
            // `IP`. Without it the limiter only ever sees the docker bridge peer.
            const user = await verifyProtocolAuth(body.email, body.password, body.ip);
            return { userId: user.id, email: user.email };
        },
        {
            body: t.Object({
                email: t.String(),
                password: t.String(),
                ip: t.Optional(t.String()),
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
            const owner = await getOrgOwner();
            if (!owner) return { notified: false };
            await sendToHome(owner.id, {
                type: 'notification',
                notification: {
                    type: 'admin-alert',
                    title: 'Mail queue backlog',
                    body: `${body.queued} messages queued`,
                    tag: 'mail-queue-backlog',
                    coalesce: true,
                },
            });
            return { notified: true };
        },
        {
            body: t.Object({
                queued: t.Integer({ minimum: 0 }),
            }),
        },
    );
