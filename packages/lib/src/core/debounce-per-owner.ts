// Collapses a burst of stream events into one refetch per owner. A bulk sync emits one event per item,
// and each would restart the open query's fetch: 500 cards meant 500 refetches per open tab, enough to
// trip the per-IP rate limit. So the invalidation runs once, delayMs after the burst's last event. A
// long trickle, such as a 2,000-photo upload, never pauses that long, so with a maxWaitMs it also runs
// maxWaitMs after the burst began, and the open view keeps up. The QueryClient travels as the argument,
// and the latest one is used, rather than in a closure kept for the owner's lifetime.

import type { QueryClient } from '@tanstack/react-query';

export function debouncePerOwner(
    invalidate: (queryClient: QueryClient, ownerId: string) => void,
    delayMs: number,
    maxWaitMs?: number,
): (queryClient: QueryClient, ownerId: string) => void {
    type Burst = {
        queryClient: QueryClient;
        quiet?: ReturnType<typeof setTimeout>;
        deadline?: ReturnType<typeof setTimeout>;
    };
    const pending = new Map<string, Burst>();
    const run = (ownerId: string) => {
        const burst = pending.get(ownerId);
        if (!burst) return;
        pending.delete(ownerId);
        clearTimeout(burst.quiet);
        clearTimeout(burst.deadline);
        invalidate(burst.queryClient, ownerId);
    };
    return (queryClient, ownerId) => {
        let burst = pending.get(ownerId);
        if (burst) {
            clearTimeout(burst.quiet);
            burst.queryClient = queryClient;
        } else {
            burst = { queryClient };
            pending.set(ownerId, burst);
            if (maxWaitMs !== undefined) burst.deadline = setTimeout(() => run(ownerId), maxWaitMs);
        }
        burst.quiet = setTimeout(() => run(ownerId), delayMs);
    };
}
