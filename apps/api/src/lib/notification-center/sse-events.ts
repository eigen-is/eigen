import type { SSEventNotificationChanged, SSEventNotificationCreated } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildNotificationCreatedEvent(
    title: string,
    body?: string | null,
    notificationType?: string,
    tag?: string | null,
): SSEventNotificationCreated {
    return {
        type: SSEventType.NOTIFICATION_CREATED,
        title,
        ...(body != null && { body }),
        ...(notificationType != null && { notificationType }),
        ...(tag != null && { tag }),
    };
}

export function buildNotificationChangedEvent(): SSEventNotificationChanged {
    return { type: SSEventType.NOTIFICATION_CHANGED };
}
