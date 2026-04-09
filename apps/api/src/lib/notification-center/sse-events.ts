import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildNotificationCreatedEvent(
    title: string,
    body?: string | null,
    notificationType?: string,
    tag?: string | null,
): SSEvent {
    return {
        type: SSEventType.NOTIFICATION_CREATED,
        title,
        ...(body != null && { body }),
        ...(notificationType != null && { notificationType }),
        ...(tag != null && { tag }),
    } as SSEvent;
}

export function buildNotificationChangedEvent(): SSEvent {
    return { type: SSEventType.NOTIFICATION_CHANGED } as SSEvent;
}
