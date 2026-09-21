// Which query keys an invalidation function asks for. `invalidateHomeSize` debounces five seconds, so
// the pending timer is run rather than waited for; every invalidator here is synchronous.
import { QueryClient } from '@tanstack/react-query';

export function invalidatedBy(invalidate: (queryClient: QueryClient) => void): unknown[][] {
    const queryClient = new QueryClient();
    const keys: unknown[][] = [];
    queryClient.invalidateQueries = ((filters?: { queryKey?: readonly unknown[] }) => {
        if (filters?.queryKey) keys.push([...filters.queryKey]);
        return Promise.resolve();
    }) as typeof queryClient.invalidateQueries;

    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void) => {
        run();
        return 0;
    }) as unknown as typeof globalThis.setTimeout;
    try {
        invalidate(queryClient);
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    return keys;
}
