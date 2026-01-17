import {useEffect, useRef, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '../../auth/auth-context';
import {emailKeys, mailboxKeys} from '../../mail';
import {driveKeys} from '../../drive';
import {SSE_EVENTS_URL} from '../../api';
import {type SSEvent, type SSEventNotification, isSSEventNotification} from '@workspace/lib/types/sse';

interface UseSSEOptions {
    onNotification?: (event: SSEvent & SSEventNotification) => void;
}

export function useSSE(options: UseSSEOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onNotification} = options;

    const handleEvent = useCallback((event: SSEvent) => {
        if (isSSEventNotification(event)) {
            onNotification?.(event);
        }

        switch (event.type) {
            case 'mail:received':
                queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
                queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
                break;

            case 'drive:acl-shared':
            case 'drive:acl-unshared':
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                break;

            case 'drive:folder-created':
            case 'drive:file-uploaded':
                if (event.data.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
                }
                break;

            case 'drive:folder-deleted':
            case 'drive:file-deleted':
                queryClient.invalidateQueries({queryKey: driveKeys.folders()});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case 'drive:path-renamed':
            case 'drive:path-moved':
                queryClient.invalidateQueries({queryKey: driveKeys.all});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case 'drive:acl-updated':
                queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                if (event.data.pathId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.path(event.data.pathId)});
                }
                if (event.data.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
                }
                break;
        }
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
