// Handles the contact and label events from the stream. Any card change refetches the owner's whole
// contact list, once per burst. A label change refetches the labels, and a rename or delete refetches
// the cards too.

import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debouncePerOwner } from '../debounce-per-owner';
import { invalidateContactList, invalidateLabelChanged, invalidateLabelCreated } from './hooks/keys';

// Debounced for a burst of card events, refetching every 1.5 s while a long one goes on. The writing tab's
// own onSuccess still refetches at once.
const invalidateListSoon = debouncePerOwner(invalidateContactList, 250, 1500);

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): void {
    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
        case SSEventType.CONTACT_UPDATED:
        case SSEventType.CONTACT_DELETED:
        // The batched event stands for a burst of the three above, so it invalidates exactly what they do.
        case SSEventType.CONTACTS_CHANGED:
            invalidateListSoon(queryClient, userId);
            break;

        case SSEventType.LABEL_CREATED:
            invalidateLabelCreated(queryClient, userId);
            break;

        case SSEventType.LABEL_UPDATED:
        case SSEventType.LABEL_DELETED:
            invalidateLabelChanged(queryClient, userId);
            break;
    }
}
