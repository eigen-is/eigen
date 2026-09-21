import type { QueryClient } from '@tanstack/react-query';
import { debounce } from 'es-toolkit';

// A bulk sync emits one SSE event per resource, and every one of them would restart the mounted refetch —
// 500 cards meant 500 refetches per open tab, enough to trip the per-IP rate limiter. This collapses a
// burst into one trailing invalidation per owner. The QueryClient travels as the argument (es-toolkit's
// debounce calls with the latest one) rather than in a closure kept for the owner's lifetime.
export function debouncePerOwner(
    invalidate: (queryClient: QueryClient, ownerId: string) => void,
    delayMs: number,
): (queryClient: QueryClient, ownerId: string) => void {
    const pending = new Map<string, (queryClient: QueryClient) => void>();
    return (queryClient, ownerId) => {
        let run = pending.get(ownerId);
        if (!run) {
            run = debounce((client: QueryClient) => invalidate(client, ownerId), delayMs);
            pending.set(ownerId, run);
        }
        run(queryClient);
    };
}
