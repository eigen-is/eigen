import {useEffect, useRef, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '../../auth/auth-context';
import {emailKeys, mailboxKeys} from '../../mail';
import {driveKeys} from '../../drive';

export interface EigenNotification {
    type: string;
    title: string;
    body: string;
    tag?: string;
    link?: string;
}

interface UseNotificationsOptions {
    onNotification?: (notification: EigenNotification) => void;
}

export function useNotifications(options: UseNotificationsOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onNotification} = options;

    const handleNotification = useCallback((notification: EigenNotification) => {
        onNotification?.(notification);

        if (notification.type === 'mail') {
            queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
        } else if (notification.type === 'acl_insert' || notification.type === 'acl_delete') {
            queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
        }
    }, [onNotification, queryClient]);

    useEffect(() => {
        if (!isAuthenticated) return;

        const apiHost = import.meta.env.VITE_API_HOST as string;
        const url = `${apiHost}/sse/notifications`;
        
        const eventSource = new EventSource(url, {withCredentials: true});
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const notification = JSON.parse(event.data) as EigenNotification;
                handleNotification(notification);
            } catch (e) {
                console.error('Failed to parse notification', e);
            }
        };

        eventSource.onerror = () => {
            console.log('SSE connection error, will auto-reconnect...');
        };

        return () => {
            eventSource.close();
            eventSourceRef.current = null;
        };
    }, [isAuthenticated, handleNotification]);

    return {
        isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
    };
}
