import {useCallback, useEffect, useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@workspace/lib/auth';
import {getSSEEventsUrl} from '../../api';
import type {SSEvent} from '@workspace/lib/types/sse';
import {handleDriveSSEvent} from '@workspace/lib/drive';
import {handleMailSSEvent} from '@workspace/lib/mail';
import {handleContactsSSEvent} from '@workspace/lib/contacts';
import {handleChatSSEvent} from '@workspace/lib/chat';
import {handleCalendarSSEvent} from '@workspace/lib/calendar';
import {handleNotificationSSEvent} from '@workspace/lib/notification';
import {handleSpaceSSEvent} from '@workspace/lib/space';
import {handleTeamSSEvent} from '@workspace/lib/team';

export function useSSE() {
    const {isAuthenticated, user} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const userIdRef = useRef(user?.id || '');
    userIdRef.current = user?.id || '';

    const handleEvent = useCallback((event: SSEvent) => {
        const userId = userIdRef.current;
        handleDriveSSEvent(event, queryClient, userId);
        handleMailSSEvent(event, queryClient, userId);
        handleContactsSSEvent(event, queryClient, userId);
        handleChatSSEvent(event, queryClient);
        handleCalendarSSEvent(event, queryClient, userId);
        handleNotificationSSEvent(event, queryClient, userId);
        handleSpaceSSEvent(event, queryClient, userId);
        handleTeamSSEvent(event, queryClient);
    }, [queryClient]);

    useEffect(() => {
        if (!isAuthenticated || !user?.id) return;

        const url = getSSEEventsUrl(user.id);
        let retryTimer: ReturnType<typeof setTimeout>;
        let stopped = false;

        function connect() {
            if (stopped) return;

            const es = new EventSource(url, {withCredentials: true});
            eventSourceRef.current = es;

            es.onmessage = (event) => {
                try {
                    const sseEvent = JSON.parse(event.data) as SSEvent;
                    handleEvent(sseEvent);
                } catch (e) {
                    console.error('Failed to parse SSE event', e);
                }
            };

            es.onerror = () => {
                if (stopped) return;
                // EventSource won't auto-reconnect after HTTP errors (e.g. 502)
                if (es.readyState === EventSource.CLOSED) {
                    es.close();
                    eventSourceRef.current = null;
                    retryTimer = setTimeout(connect, 5000);
                }
            };
        }

        connect();

        return () => {
            stopped = true;
            clearTimeout(retryTimer);
            eventSourceRef.current?.close();
            eventSourceRef.current = null;
        };
    }, [isAuthenticated, user?.id, handleEvent]);

    return {
        isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
    };
}
