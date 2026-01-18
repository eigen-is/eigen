import {useCallback, useEffect, useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '@workspace/ui/lib/auth';
import {SSE_EVENTS_URL} from '../../api';
import {isSSEventNotification, type SSEvent, type SSEventNotification} from '@workspace/lib/types/sse';
import {handleDriveSSEvent} from '@workspace/ui/lib/drive';
import {handleMailSSEvent} from '@workspace/ui/lib/mail';

type UseSSEOptions = {
    onNotification?: (event: SSEvent & SSEventNotification) => void;
};

export function useSSE(options: UseSSEOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onNotification} = options;

    const handleEvent = useCallback((event: SSEvent) => {
        if (isSSEventNotification(event)) {
            onNotification?.(event);
        }

        handleDriveSSEvent(event, queryClient);
        handleMailSSEvent(event, queryClient);
    }, [onNotification, queryClient]);

    useEffect(() => {
        if (!isAuthenticated) return;

        const url = SSE_EVENTS_URL;

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
    }, [isAuthenticated, handleEvent]);

    return {
        isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
    };
}
