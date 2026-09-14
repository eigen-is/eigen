import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debounce } from 'es-toolkit';
import { invalidateContactList, invalidateLabelChanged, invalidateLabelCreated } from './hooks/keys';

// A whole-book import or a CardDAV bulk sync emits one event per card, and every card's invalidation
// restarts the mounted list refetch — 500 cards used to mean 500 refetches per open tab, enough to trip the
// per-IP rate limiter. One trailing refetch per owner per burst instead. The importing tab's own onSuccess
// invalidation is untouched, so a single write still lands immediately.
const INVALIDATE_DEBOUNCE_MS = 250;
const debouncedListInvalidations = new Map<string, (queryClient: QueryClient) => void>();

// The QueryClient travels as the argument (es-toolkit's debounce calls with the latest ones) rather than
// in the closure, which is stored for the owner's lifetime.
function invalidateListSoon(queryClient: QueryClient, ownerId: string): void {
    let run = debouncedListInvalidations.get(ownerId);
    if (!run) {
        run = debounce((client: QueryClient) => invalidateContactList(client, ownerId), INVALIDATE_DEBOUNCE_MS);
        debouncedListInvalidations.set(ownerId, run);
    }
    run(queryClient);
}

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('contacts:')) return false;

    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
        case SSEventType.CONTACT_UPDATED:
        case SSEventType.CONTACT_DELETED:
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
