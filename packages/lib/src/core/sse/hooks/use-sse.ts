// Holds the signed-in tab's one event stream from its user's own Home, and hands every event to
// handleSSEvent, which refreshes the queries the event names. The app's provider stack mounts it once.
// It reconnects with a growing delay after the stream closes on an HTTP error.

import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@workspace/lib/auth';
import type { SSEvent } from '@workspace/lib/types/sse';
import { useEffect } from 'react';
import { getSSEEventsUrl } from '../../api';
import { handleSSEvent } from '../sse-handlers';

const FIRST_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

export function useSSE(): void {
    const { isAuthenticated, user } = useAuth();
    const queryClient = useQueryClient();
    const userId = user?.id;

    useEffect(() => {
        if (!isAuthenticated || !userId) return;

        const url = getSSEEventsUrl(userId);
        let eventSource: EventSource | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let retryDelay = FIRST_RETRY_DELAY_MS;
        let stopped = false;

        const connect = () => {
            if (stopped) return;

            const source = new EventSource(url, { withCredentials: true });
            eventSource = source;

            source.onopen = () => {
                retryDelay = FIRST_RETRY_DELAY_MS;
            };

            source.onmessage = (message) => {
                try {
                    const event: SSEvent = JSON.parse(message.data);
                    handleSSEvent(event, queryClient, userId);
                } catch (e) {
                    console.error('SSE event failed', e);
                }
            };

            source.onerror = () => {
                if (stopped) return;
                // EventSource reconnects by itself after a network error, but not after an HTTP error such as a 502.
                if (source.readyState === EventSource.CLOSED) {
                    source.close();
                    const jitter = retryDelay * 0.2 * Math.random();
                    retryTimer = setTimeout(connect, retryDelay + jitter);
                    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
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
