import {useEffect, useRef, useCallback} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {useAuth} from '../../auth/auth-context';
import {emailKeys, mailboxKeys} from '../../mail';
import {driveKeys} from '../../drive';
import {SSE_NOTIFICATIONS_URL} from '../../api';
import {NotificationTypes, type EigenNotification} from '@workspace/lib/types/notification';

interface UseNotificationsOptions {
    onNotification?: (notification: EigenNotification) => void;
}

export function useNotifications(options: UseNotificationsOptions = {}) {
    const {isAuthenticated} = useAuth();
    const queryClient = useQueryClient();
    const eventSourceRef = useRef<EventSource | null>(null);
    const {onNotification} = options;

    const handleNotification = useCallback((notification: EigenNotification) => {
        const showToast = notification.showToast !== false;
        if (showToast) {
            onNotification?.(notification);
        }

        switch (notification.type) {
            case NotificationTypes.MAIL_RECEIVED:
                queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
                queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
                break;

            case NotificationTypes.DRIVE_ACL_SHARED:
            case NotificationTypes.DRIVE_ACL_UNSHARED:
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                break;

            case NotificationTypes.DRIVE_FOLDER_CREATED:
            case NotificationTypes.DRIVE_FILE_UPLOADED:
                if (notification.data?.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(notification.data.parentId)});
                }
                break;

            case NotificationTypes.DRIVE_FOLDER_DELETED:
            case NotificationTypes.DRIVE_FILE_DELETED:
                queryClient.invalidateQueries({queryKey: driveKeys.folders()});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case NotificationTypes.DRIVE_PATH_RENAMED:
            case NotificationTypes.DRIVE_PATH_MOVED:
                queryClient.invalidateQueries({queryKey: driveKeys.all});
                queryClient.invalidateQueries({queryKey: driveKeys.mimeTypes()});
                break;

            case NotificationTypes.DRIVE_ACL_UPDATED:
                queryClient.invalidateQueries({queryKey: driveKeys.shared('by-me')});
                queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                if (notification.data?.pathId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.path(notification.data.pathId)});
                }
                if (notification.data?.parentId) {
                    queryClient.invalidateQueries({queryKey: driveKeys.folder(notification.data.parentId)});
                }
                break;
        }
    }, [onNotification, queryClient]);

    useEffect(() => {
        if (!isAuthenticated) return;

        const url = SSE_NOTIFICATIONS_URL;
        
        const eventSource = new EventSource(url, {withCredentials: true});
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const notification = JSON.parse(event.data) as EigenNotification;
                handleNotification(notification);
                console.log('Received notification', notification);
            } catch (e) {
                console.error('Failed to parse notification', e);
            }
        };

        // eventSource.onerror = () => {
        //     console.log('SSE connection error, will auto-reconnect...');
        // };

        return () => {
            eventSource.close();
            eventSourceRef.current = null;
        };
    }, [isAuthenticated, handleNotification]);

    return {
        isConnected: eventSourceRef.current?.readyState === EventSource.OPEN
    };
}
