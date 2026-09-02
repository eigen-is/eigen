import { AppError } from '../api-error';

// Create budgets. Storage that has gone slow (S3 stalling on `exists`) can leave a create in limbo:
// the request times out or 5xx's while the server keeps writing and the row lands seconds later.
// The create hooks give the request 15s, then poll the listing for ~10s before calling it a failure.
export const CREATE_TIMEOUT_MS = 15_000;
export const RECONCILE_ATTEMPTS = 3;
export const RECONCILE_DELAY_MS = 5_000;
// The server stamps createdAt, so the floor allows a minute of client/server clock drift; more drift
// than that makes reconcile miss (honest toast), never match a row we didn't create.
export const CREATE_CLOCK_SKEW_MS = 60_000;

// The create failed AND the item never showed up. Carries the copy the toast shows (onMutationError
// reads Error.message), with the original failure as `cause`.
export class CreateUnconfirmedError extends Error {
    constructor(cause: unknown) {
        super('Storage is responding slowly. The item may still appear in the list automatically.', { cause });
        this.name = 'CreateUnconfirmedError';
    }
}

// Polls a listing for an item the server may or may not have created. Names are stored NFC
// (Mount's validateName), so the expected name is normalized before comparing. `since` floors the
// match on createdAt, so a same-name sibling that predates the create can never pass for it (the
// server may rename ours — chat's dedupeName — and we must miss honestly instead). A poll that
// itself fails is just a miss — the next one still runs.
export async function reconcileCreatedItem<T extends { name: string; createdAt: Date }>({
    listFolder,
    expectedName,
    since,
    attempts,
    delayMs,
}: {
    listFolder: () => Promise<T[]>;
    expectedName: string;
    since: Date;
    attempts: number;
    delayMs: number;
}): Promise<T | null> {
    const target = expectedName.normalize('NFC');
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const items = await listFolder().catch(() => []);
        const match = items.find((item) => item.name === target && item.createdAt >= since);
        if (match) return match;
    }
    return null;
}

// Wraps a create mutation: on an indeterminate failure (abort, network, 5xx) poll the listing and
// treat a found item as the create's result, so a slow storage backend doesn't hand the user an
// error for a row that exists. A 4xx is the server's definitive "no" (409 duplicate name, 507 over
// quota) — it must not reconcile, or a same-name sibling would pass for the item we tried to create.
export async function createWithReconcile<T extends { name: string; createdAt: Date }>({
    create,
    listFolder,
    expectedName,
    attempts = RECONCILE_ATTEMPTS,
    delayMs = RECONCILE_DELAY_MS,
}: {
    create: () => Promise<T>;
    listFolder: () => Promise<T[]>;
    expectedName: string;
    attempts?: number;
    delayMs?: number;
}): Promise<T> {
    const since = new Date(Date.now() - CREATE_CLOCK_SKEW_MS);
    try {
        return await create();
    } catch (error) {
        if (error instanceof AppError && error.status >= 400 && error.status < 500) throw error;
        const found = await reconcileCreatedItem({ listFolder, expectedName, since, attempts, delayMs });
        if (!found) throw new CreateUnconfirmedError(error);
        return found;
    }
}
