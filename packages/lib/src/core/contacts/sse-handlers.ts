import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import {
    invalidateContactCreated,
    invalidateContactDeleted,
    invalidateContactUpdated,
    invalidateLabelCreated,
    invalidateLabelDeleted,
    invalidateLabelUpdated,
} from './hooks/keys';

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('contacts:')) return false;

    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
            invalidateContactCreated(queryClient, userId);
            return true;

        case SSEventType.CONTACT_UPDATED:
            invalidateContactUpdated(queryClient, userId, event.contactId);
            return true;

        case SSEventType.CONTACT_DELETED:
            invalidateContactDeleted(queryClient, userId, event.contactId);
            return true;

        case SSEventType.LABEL_CREATED:
            invalidateLabelCreated(queryClient, userId);
            return true;

        case SSEventType.LABEL_UPDATED:
            invalidateLabelUpdated(queryClient, userId, event.labelId);
            return true;

        case SSEventType.LABEL_DELETED:
            invalidateLabelDeleted(queryClient, userId, event.labelId);
            return true;

        default:
            return false;
    }
}
