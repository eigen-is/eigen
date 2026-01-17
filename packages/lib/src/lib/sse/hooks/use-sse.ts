import {useEffect, useRef, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '../../auth/auth-context';
import {emailKeys, mailboxKeys} from '../../mail';
import {driveKeys} from '../../drive';
import {SSE_EVENTS_URL} from '../../api';
import {SSEEventTypes, type SSEEvent} from '@workspace/lib/types/sse';

interface UseSSEOptions {
    onEvent?: (event: SSEEvent) => void;
}

export function useSSE(options: UseSSEOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onEvent} = options;

    const handleEvent = useCallback((event: SSEEvent) => {
        const showToast = event.showToast !== false;
        if (showToast) {
            onEvent?.(event);
        }

        switch (event.type) {
            case SSEEventTypes.MAIL_RECEIVED:
                queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
                queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
                break;

            case SSEEventTypes.DRIVE_ACL_SHARED:
            case SSEEventTypes.DRIVE_ACL_UNSHARED:
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                break;

            case SSEEventTypes.DRIVE_FOLDER_CREATED:
            case SSEEventTypes.DRIVE_FILE_UPLOADED:
                if (event.data?.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
                }
                break;

            case SSEEventTypes.DRIVE_FOLDER_DELETED:
            case SSEEventTypes.DRIVE_FILE_DELETED:
                queryClient.invalidateQueries({queryKey: driveKeys.folders()});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case SSEEventTypes.DRIVE_PATH_RENAMED:
            case SSEEventTypes.DRIVE_PATH_MOVED:
                queryClient.invalidateQueries({queryKey: driveKeys.all});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case SSEEventTypes.DRIVE_ACL_UPDATED:
                queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                if (event.data?.pathId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.path(event.data.pathId)});
                }
                if (event.data?.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(event.data.parentId)});
                }
                break;
        }
    }, [onEvent, queryClient]);

    useEffect(() => {
        if (!isAuthenticated) return;

        const url = SSE_EVENTS_URL;
        
        const eventSource = new EventSource(url, {withCredentials: true});
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const sseEvent = JSON.parse(event.data) as SSEEvent;
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
