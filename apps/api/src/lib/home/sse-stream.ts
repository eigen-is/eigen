// The event stream of one user's own Home, which the SSE route hands to a signed-in tab. It passes on every event
// the Home broadcasts, and it holds the Home, so the Home stays open while the tab is. When the Home closes anyway,
// such as for a restore or the shutdown, the stream ends and the browser reconnects to the next Home. It sends the
// restart notice the server holds, or that it holds none, and the data epochs when it opens. A keepalive goes out
// then and every 15 seconds, so a proxy keeps the connection, and the data epochs go out with each one.

import type { SSEvent } from '@workspace/lib/types/sse';
import { sse } from 'elysia';
import { buildRestartNoticeEvent } from '../config/restart-notice';
import type { Home } from './home';
import { buildDataEpochsEvent } from './sse-events';

// A named event with no data: the browser never dispatches it to onmessage, but its bytes keep a proxy awake.
const keepaliveItem = () => sse({ event: 'keepalive' });
const KEEPALIVE_INTERVAL_MS = 15_000;

type StreamItem = SSEvent | ReturnType<typeof keepaliveItem>;

// Throws the Home's 503 when it is closing, so the route answers with it and the browser retries.
export function createSSEStream(home: Home): ReadableStream<StreamItem> {
    const userId = home.user.id;
    let streamController: ReadableStreamDefaultController<StreamItem> | null = null;
    let keepalive: Timer | undefined;
    let releaseHome: (() => void) | undefined;
    let isClosed = false;

    // Runs once, whichever way the stream ends: the client leaves, the Home closes, or a send fails.
    const teardown = () => {
        if (isClosed) return;
        isClosed = true;
        clearInterval(keepalive);
        home.unsubscribeSSE(send);
        releaseHome?.();
    };

    const send = (item: StreamItem) => {
        if (isClosed || streamController === null) return;
        try {
            streamController.enqueue(item);
        } catch {
            teardown();
        }
    };

    // On open and with every keepalive, so a tab hears a restore of another home it reads, such as a team's.
    const announceDataEpochs = () =>
        buildDataEpochsEvent(userId)
            .then(send)
            .catch((e) => console.error(`[SSE] Failed to announce data epochs for ${userId}:`, e));

    return new ReadableStream({
        start: (controller) => {
            streamController = controller;
            // Elysia calls cancel only when the client leaves, never when the stream closes itself, so the
            // teardown runs here first.
            releaseHome = home.hold(() => {
                teardown();
                controller.close();
            });
            home.subscribeSSE(send);
            send(keepaliveItem());
            // With none too, so a tab that reconnects to a restarted server drops the notice it held.
            send(buildRestartNoticeEvent());
            announceDataEpochs();

            keepalive = setInterval(() => {
                send(keepaliveItem());
                announceDataEpochs();
            }, KEEPALIVE_INTERVAL_MS);
        },
        cancel: teardown,
    });
}
