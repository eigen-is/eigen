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
        handleDriveSSEvent(event, queryClient);
        handleMailSSEvent(event, queryClient, userId);
        handleContactsSSEvent(event, queryClient, userId);
        handleChatSSEvent(event, queryClient);
        handleCalendarSSEvent(event, queryClient);
        handleSpaceSSEvent(event, queryClient, userId);
        handleTeamSSEvent(event, queryClient);
    }, [queryClient]);

    useEffect(() => {
        if (!isAuthenticated || !user?.id) return;

        const url = getSSEEventsUrl(user.id);

        const eventSource = new EventSource(url, {withCredentials: true});
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const sseEvent = JSON.parse(event.data) as SSEvent;
                handleEvent(sseEvent);
            } catch (e) {
                console.error('Failed to parse SSE event', e);
            }
        };

        return () => {
            eventSource.close();
            eventSourceRef.current = null;
        };
    }, [isAuthenticated, user?.id, handleEvent]);

    return {
        isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
    };
}
