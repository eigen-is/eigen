import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { toast } from 'sonner';
import { invalidateNotifications } from './hooks/use-notifications';

export function handleNotificationSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('notification:')) return false;

    switch (event.type) {
        case SSEventType.NOTIFICATION_CREATED:
            invalidateNotifications(queryClient, userId);
            toast(event.title, event.body ? { description: event.body } : undefined);
            return true;

        default:
            return false;
    }
}
