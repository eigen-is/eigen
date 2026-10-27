// Holds the signed-in tab's one event stream from its user's own Home, and hands every event to
// handleSSEvent, which refreshes the queries the event names. The app's provider stack mounts it once.
// It reconnects with a growing delay after the stream closes on an HTTP error.

import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@workspace/lib/auth';
import type { SSEvent } from '@workspace/lib/types/sse';
import { useEffect } from 'react';
import { getSSEEventsUrl } from '../../api';
import { handleSSEvent } from '../sse-handlers';

export function useSSE(): void {
    const { isAuthenticated, user } = useAuth();
    const queryClient = useQueryClient();
    const userId = user?.id;

    useEffect(() => {
        if (!isAuthenticated || !userId) return;

        const url = getSSEEventsUrl(userId);
        let eventSource: EventSource | null = null;
        let retryTimer: ReturnType<typeof setTimeout>;
        let retryDelay = 1000;
        let stopped = false;

        const connect = () => {
            if (stopped) return;

            const es = new EventSource(url, { withCredentials: true });
            eventSource = es;

            es.onopen = () => {
                retryDelay = 1000;
            };

            es.onmessage = (message) => {
                try {
                    handleSSEvent(JSON.parse(message.data) as SSEvent, queryClient, userId);
                } catch (e) {
                    console.error('SSE event failed', e);
                }
            };

            es.onerror = () => {
                if (stopped) return;
                // EventSource reconnects by itself after a network error, but not after an HTTP error such as a 502.
                if (es.readyState === EventSource.CLOSED) {
                    es.close();
                    const jitter = retryDelay * 0.2 * Math.random();
                    retryTimer = setTimeout(connect, retryDelay + jitter);
                    retryDelay = Math.min(retryDelay * 2, 30000);
                }
            };
        };

        connect();

        return () => {
            stopped = true;
            clearTimeout(retryTimer);
            eventSource?.close();
        };
    }, [isAuthenticated, userId, queryClient]);
}
