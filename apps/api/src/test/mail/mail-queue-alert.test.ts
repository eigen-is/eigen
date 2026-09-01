import { beforeAll, describe, expect, test } from 'bun:test';
import type { Notification } from '@workspace/lib/types/notification';
import { getHome } from '../../lib/home';
import { getOrgOwner } from '../../lib/user';
import { app } from '../setup';

function queueAlert(queued: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return app.handle(
        new Request('http://localhost/internal/mail/queue-alert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ queued }),
        }),
    );
}

// The postfix container's queue-monitor.sh is the only thing that can see the queue (private
// volume) — it POSTs here, and the org owner gets an in-app notification. Mail is deliberately
// not the channel: an alert emitted into the jammed queue is self-defeating.
describe('Mail queue alert', () => {
    let ownerId: string;

    beforeAll(async () => {
        const owner = await getOrgOwner();
        ownerId = owner!.id;
    });

    async function ownerNotifications(): Promise<Notification[]> {
        const home = await getHome(ownerId);
        return home.notifications.list();
    }

    test('persists an admin-alert notification for the org owner', async () => {
        const res = await queueAlert(731);
        expect(res.status).toBe(200);

        const alert = (await ownerNotifications()).find((n) => n.type === 'admin-alert');
        expect(alert).toBeTruthy();
        expect(alert?.title).toBe('Mail queue backlog');
        expect(alert?.body).toBe('731 messages queued');
    });

    test('rejects a body without a queued count', async () => {
        const res = await app.handle(
            new Request('http://localhost/internal/mail/queue-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(res.status).toBe(422);
    });

    // Same gate as its /internal siblings: Caddy 404s the path at the edge, and a proxied request
    // is refused here even if it got through, since a genuine bridge caller sets no proxy headers.
    test('is unreachable through a proxy (requireLocalhost)', async () => {
        const res = await queueAlert(731, { 'X-Forwarded-For': '203.0.113.9' });
        expect(res.status).toBe(403);
    });
});
