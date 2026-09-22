import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
import { invalidateContactList, invalidateLabelChanged, invalidateLabelCreated } from './hooks/keys';

// A whole-file import sends the one batched contacts:changed instead. The importing tab's own onSuccess
// invalidation is untouched, so a single write still lands immediately.
const invalidateListSoon = debouncePerOwner(invalidateContactList, 250);

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('contacts:')) return false;

    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
        case SSEventType.CONTACT_UPDATED:
        case SSEventType.CONTACT_DELETED:
        // The batched event stands for a burst of the three above, so it invalidates exactly what they do.
        case SSEventType.CONTACTS_CHANGED:
            invalidateListSoon(queryClient, userId);
            return true;

        case SSEventType.LABEL_CREATED:
            invalidateLabelCreated(queryClient, userId);
            return true;

        case SSEventType.LABEL_UPDATED:
        case SSEventType.LABEL_DELETED:
            invalidateLabelChanged(queryClient, userId);
            return true;

        default:
            return false;
    }
}
