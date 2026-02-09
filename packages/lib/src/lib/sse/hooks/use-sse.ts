import {useCallback, useEffect, useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@workspace/lib/auth';
import {getSSEEventsUrl} from '../../api';
import {isSSEventNotification, type SSEvent, type SSEventNotification} from '@workspace/lib/types/sse';
import {handleDriveSSEvent} from '@workspace/lib/drive';
import {handleMailSSEvent} from '@workspace/lib/mail';
import {handleContactsSSEvent} from '@workspace/lib/contacts';

type UseSSEOptions = {
    onNotification?: (event: SSEvent & SSEventNotification) => void;
};

export function useSSE(options: UseSSEOptions = {}) {
    const {isAuthenticated, user} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onNotification} = options;

    const handleEvent = useCallback((event: SSEvent) => {
        if (isSSEventNotification(event)) {
            onNotification?.(event);
        }

        handleDriveSSEvent(event, queryClient);
        handleMailSSEvent(event, queryClient);
        handleContactsSSEvent(event, queryClient);
    }, [onNotification, queryClient]);

    useEffect(() => {
        if (!isAuthenticated || !user?.id) return;

        const url = getSSEEventsUrl(user.id);

        const eventSource = new EventSource(url, {withCredentials: true});
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const sseEvent = JSON.parse(event.data) as SSEvent;
                handleEvent(sseEvent);
                console.log('Received SSE event', sseEvent);
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
