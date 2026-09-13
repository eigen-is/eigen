import type { QueryClient } from '@tanstack/react-query';
import type { SSEvent } from '@workspace/lib/types/sse';
import { SSEventType } from '@workspace/lib/types/sse';
import { debounce } from 'es-toolkit';
import {
    invalidateContactCreated,
    invalidateContactDeleted,
    invalidateContactUpdated,
    invalidateLabelCreated,
    invalidateLabelDeleted,
    invalidateLabelUpdated,
} from './hooks/keys';

// A whole-book import or a CardDAV sync emits one event per card, and every card's invalidation restarts
// the mounted list refetch — 500 cards used to mean 500 refetches per open tab, enough to trip the
// per-IP rate limiter. Each event kind is collapsed per key into one trailing refetch instead; the
// importing tab's own onSuccess invalidation is untouched, so a single write still lands immediately.
const INVALIDATE_DEBOUNCE_MS = 250;
const debouncedInvalidations = new Map<string, (queryClient: QueryClient) => void>();

// The key carries the owner and the record the event is about, so a burst never drops another card's
// invalidation — only repeats of the same one collapse. The QueryClient travels as the argument
// (es-toolkit's debounce calls with the latest ones) rather than in the closure, which is stored.
function invalidateSoon(key: string, queryClient: QueryClient, invalidate: (queryClient: QueryClient) => void): void {
    let run = debouncedInvalidations.get(key);
    if (!run) {
        run = debounce(invalidate, INVALIDATE_DEBOUNCE_MS);
        debouncedInvalidations.set(key, run);
    }
    run(queryClient);
}

export function handleContactsSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    if (!event?.type?.startsWith('contacts:')) return false;

    switch (event.type) {
        case SSEventType.CONTACT_CREATED:
            invalidateSoon(`${event.type}:${userId}`, queryClient, (client) =>
                invalidateContactCreated(client, userId),
            );
            return true;

        case SSEventType.CONTACT_UPDATED:
            invalidateSoon(`${event.type}:${userId}:${event.contactId}`, queryClient, (client) =>
                invalidateContactUpdated(client, userId, event.contactId),
            );
            return true;

        case SSEventType.CONTACT_DELETED:
            invalidateSoon(`${event.type}:${userId}:${event.contactId}`, queryClient, (client) =>
                invalidateContactDeleted(client, userId, event.contactId),
            );
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
