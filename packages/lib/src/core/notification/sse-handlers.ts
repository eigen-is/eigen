import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { toast } from 'sonner';
import { invalidateNotifications } from './hooks/use-notifications';
import { isClickableNotification, resolveNotificationLink } from './resolve-link';

export function handleNotificationSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('notification:')) return false;

    switch (event.type) {
        case SSEventType.NOTIFICATION_CREATED: {
            invalidateNotifications(queryClient, userId);
            const options: Parameters<typeof toast>[1] = event.body ? { description: event.body } : {};
            const notificationType = event.notificationType;
            const tag = event.tag;
            if (notificationType && tag && isClickableNotification(notificationType)) {
                options.action = {
                    label: 'View',
                    onClick: () => {
                        resolveNotificationLink({ type: notificationType, tag })
                            .then((url) => {
                                if (url) window.location.href = url;
                            })
                            .catch(() => {});
                    },
                };
            }
            toast(event.title, options);
            return true;
        }

        case SSEventType.NOTIFICATION_CHANGED:
            invalidateNotifications(queryClient, userId);
            return true;

        default:
            return false;
    }
}
