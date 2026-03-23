import type {SSEvent} from '@workspace/lib/types/sse';
import {SSEventType} from '@workspace/lib/types/sse';

export function buildNotificationCreatedEvent(title: string, body?: string | null): SSEvent {
    return {
        type: SSEventType.NOTIFICATION_CREATED,
        title,
        ...(body != null && {body}),
    } as SSEvent;
}
