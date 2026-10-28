// Builds the two notification events. notification:created raises the toast in the user's open tabs and
// refreshes the bell; notification:changed only refreshes the bell, after a change such as a read. The
// NotificationCenter sends them after it writes the row, so a toast always has a row behind it.

import type { NotificationPersistInput } from '@workspace/lib/types/notification';
import type { SSEventNotificationChanged, SSEventNotificationCreated } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';

export function buildNotificationCreatedEvent(input: NotificationPersistInput): SSEventNotificationCreated {
    return {
        type: SSEventType.NOTIFICATION_CREATED,
        title: input.title,
        notificationType: input.type,
        ...(input.body != null && { body: input.body }),
        ...(input.tag != null && { tag: input.tag }),
    };
}

export function buildNotificationChangedEvent(): SSEventNotificationChanged {
    return { type: SSEventType.NOTIFICATION_CHANGED };
}
