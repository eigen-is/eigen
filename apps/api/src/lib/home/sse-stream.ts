import type { SSEvent } from '@workspace/lib/types/sse';
import { getHome } from './get-home';
import type { Home } from './home';

type StreamItem = SSEvent | { event: string };

export function createSSEStream(home: Home): ReadableStream<StreamItem> {
    let keepalive: Timer | null = null;
    let isClosed = false;
    let currentHome: Home = home;
    let streamController: ReadableStreamDefaultController<StreamItem> | null = null;

    const listener = (event: SSEvent) => {
        if (isClosed || streamController === null || streamController.desiredSize === null) return;
        try {
            streamController.enqueue(event);
        } catch {
            isClosed = true;
        }
    };

    return new ReadableStream({
        start: (controller) => {
            streamController = controller;
            currentHome.subscribeSSE(listener);

            try {
                controller.enqueue({ event: 'keepalive' });
            } catch {
                isClosed = true;
            }

            keepalive = setInterval(async () => {
                if (isClosed) return;

                // Re-acquire: the Home may have been evicted and recreated under a long-lived stream.
                try {
                    const freshHome = await getHome(home.user.id);
                    if (freshHome !== currentHome) {
                        console.log(`[SSE] Home recreated for ${home.user.id}, re-subscribing`);
                        currentHome.unsubscribeSSE(listener);
                        freshHome.subscribeSSE(listener);
                        currentHome = freshHome;
                    }
                } catch (e) {
                    console.error(`[SSE] Failed to get Home for ${home.user.id}:`, e);
                }

                if (controller.desiredSize === null) {
                    isClosed = true;
                    return;
                }
                try {
                    controller.enqueue({ event: 'keepalive' });
                } catch {
                    isClosed = true;
                }
            }, 15000);
        },
        cancel: () => {
            isClosed = true;
            if (keepalive) clearInterval(keepalive);
            currentHome.unsubscribeSSE(listener);
        },
    });
}
