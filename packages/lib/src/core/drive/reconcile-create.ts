// A create on slow storage can time out or fail while the server keeps writing, and the item lands seconds later.
// The create hooks, such as a new document's or a new chat's, run their request through createWithReconcile, which
// polls the folder listing before it reports a failure, so the user doesn't create the item twice.

import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { AppError } from '../api-error';

// The request gets 15 s, then the listing is polled for about 10 s.
export const CREATE_TIMEOUT_MS = 15_000;
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_DELAY_MS = 5_000;

// One listing fetch for a reconcile: cache-bypassing, and retry-free because the poll loop is the
// retry — the query config's own `retry` would double the GETs against storage already struggling.
export function fetchListingOnce<T>(
    queryClient: QueryClient,
    config: { queryKey: QueryKey; queryFn: () => Promise<T> },
): Promise<T> {
    return queryClient.fetchQuery({ ...config, staleTime: 0, retry: false });
}

// A 4xx is the server's definite no, such as a duplicate name, so it is never reconciled.
export async function createWithReconcile<T extends { id: string; name: string }>({
    create,
    listFolder,
    expectedName,
}: {
    create: () => Promise<T>;
    listFolder: () => Promise<T[]>;
    // Omitted when the server may store another name, such as a deduplicated one, so nothing is polled.
    expectedName?: string;
}): Promise<T> {
    // Names are stored NFC, so the match compares the normalized form.
    const target = expectedName?.normalize('NFC');
    const knownIds = target
        ? await listFolder()
              .then((items) => new Set(items.map((item) => item.id)))
              .catch(() => null)
        : null;
    try {
        return await create();
    } catch (error) {
        if (error instanceof AppError && error.status >= 400 && error.status < 500) throw error;
        if (target && knownIds) {
            for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECONCILE_DELAY_MS));
                const items = await listFolder().catch(() => []);
                const match = items.find((item) => item.name === target && !knownIds.has(item.id));
                if (match) return match;
            }
        }
        // The create failed and the item never showed up. onMutationError toasts this message.
        throw new Error('Storage is responding slowly. The item may still appear in the list automatically.', {
            cause: error,
        });
    }
}
