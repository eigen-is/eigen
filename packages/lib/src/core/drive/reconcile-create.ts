import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { AppError } from '../api-error';

// Create budgets. Storage that has gone slow (S3 stalling on `exists`) can leave a create in limbo:
// the request times out or 5xx's while the server keeps writing and the row lands seconds later.
// The create hooks give the request 15s, then poll the listing for ~10s before calling it a failure.
export const CREATE_TIMEOUT_MS = 15_000;
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_DELAY_MS = 5_000;

// The create failed AND the item never showed up. Carries the copy the toast shows (onMutationError
// reads Error.message), with the original failure as `cause`.
export class CreateUnconfirmedError extends Error {
    constructor(cause: unknown) {
        super('Storage is responding slowly. The item may still appear in the list automatically.', { cause });
        this.name = 'CreateUnconfirmedError';
    }
}

// One listing fetch for a reconcile: cache-bypassing, and retry-free because the poll loop is the
// retry — the query config's own `retry` would double the GETs against storage already struggling.
export function fetchListingOnce<T>(
    queryClient: QueryClient,
    config: { queryKey: QueryKey; queryFn: () => Promise<T> },
): Promise<T> {
    return queryClient.fetchQuery({ ...config, staleTime: 0, retry: false });
}

// A 4xx is the server's definitive "no" (409 duplicate name), so it is never reconciled. The rest
// of the contract is in docs/STORAGE.md § Create reconcile.
export async function createWithReconcile<T extends { id: string; name: string }>({
    create,
    listFolder,
    expectedName,
    delayMs = RECONCILE_DELAY_MS, // test seam
}: {
    create: () => Promise<T>;
    listFolder: () => Promise<T[]>;
    // Omitted when the stored name can differ from the one sent (chat's dedupeName): nothing could
    // honestly match, so the create runs with no snapshot and no polls, error handling unchanged.
    expectedName?: string;
    delayMs?: number;
}): Promise<T> {
    // Names are stored NFC (Mount's validateName), so compare against the normalized form.
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
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
                const items = await listFolder().catch(() => []);
                const match = items.find((item) => item.name === target && !knownIds.has(item.id));
                if (match) return match;
            }
        }
        throw new CreateUnconfirmedError(error);
    }
}
