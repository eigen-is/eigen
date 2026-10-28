// The event stream of one user's own Home, which the SSE route hands to a signed-in tab. It passes on
// every event the Home broadcasts. It also sends a keepalive when it opens and every 15 seconds, so a
// proxy keeps the connection and the Home does not go idle under an open tab. With each keepalive it
// announces the data epochs, and it follows the Home when an evicted one was built again.

import type { SSEKeepalive, SSEStreamItem } from '@workspace/lib/types/sse';
import { getHome } from './get-home';
import type { Home } from './home';
import { buildDataEpochsEvent } from './sse-events';

const KEEPALIVE: SSEKeepalive = { event: 'keepalive' };
const KEEPALIVE_INTERVAL_MS = 15_000;

export function createSSEStream(home: Home): ReadableStream<SSEStreamItem> {
    const userId = home.user.id;
    let currentHome = home;
    let streamController: ReadableStreamDefaultController<SSEStreamItem> | null = null;
    let keepalive: Timer | null = null;
    let isClosed = false;

    const send = (item: SSEStreamItem) => {
        if (isClosed || streamController === null) return;
        try {
            streamController.enqueue(item);
        } catch {
            isClosed = true;
        }
    };

    // On open and with every keepalive, so a tab hears a restore whether it stayed connected or reconnected after it.
    const announceDataEpochs = () =>
        buildDataEpochsEvent(userId)
            .then(send)
            .catch((e) => console.error(`[SSE] Failed to announce data epochs for ${userId}:`, e));

    return new ReadableStream({
        start: (controller) => {
            streamController = controller;
            currentHome.subscribeSSE(send);
            send(KEEPALIVE);
            announceDataEpochs();

            keepalive = setInterval(async () => {
                if (isClosed) return;

                // getHome also keeps the Home from going idle. When it was evicted and built again, the
                // listener moves to the new one, or the stream would go silent.
                try {
                    const freshHome = await getHome(userId);
                    if (freshHome !== currentHome) {
                        console.log(`[SSE] Home recreated for ${userId}, re-subscribing`);
                        currentHome.unsubscribeSSE(send);
                        freshHome.subscribeSSE(send);
                        currentHome = freshHome;
                    }
                } catch (e) {
                    console.error(`[SSE] Failed to get Home for ${userId}:`, e);
                }

                send(KEEPALIVE);
                if (!isClosed) announceDataEpochs();
            }, KEEPALIVE_INTERVAL_MS);
        },
        cancel: () => {
            isClosed = true;
            if (keepalive) clearInterval(keepalive);
            currentHome.unsubscribeSSE(send);
        },
    });
}
