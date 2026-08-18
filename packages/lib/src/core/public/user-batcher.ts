import { publicApi } from '@workspace/lib/api';
import { MAX_PUBLIC_USERS_PER_BATCH } from '@workspace/lib/constants/public';
import type { PublicUser } from '../../types/public';

type PendingResolve = (user: PublicUser | null) => void;

let pending = new Map<string, PendingResolve>();
let scheduled = false;

async function flushBatch() {
    scheduled = false;
    const batch = pending;
    pending = new Map();

    const ids = [...batch.keys()];
    if (ids.length === 0) return;

    // Single ID — use the existing GET endpoint (avoids POST for common case)
    if (ids.length === 1) {
        const id = ids[0];
        const resolve = batch.get(id)!;
        try {
            const res = await publicApi.user({ emailOrId: id }).get();
            resolve(res.data ?? null);
        } catch {
            resolve(null);
        }
        return;
    }

    // Multiple IDs — batch POST, chunked to the server's cap. Resolve null for
    // not-found users so TanStack Query caches the miss instead of retrying.
    try {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += MAX_PUBLIC_USERS_PER_BATCH) {
            chunks.push(ids.slice(i, i + MAX_PUBLIC_USERS_PER_BATCH));
        }
        const results = await Promise.all(chunks.map((chunk) => publicApi.users.post({ ids: chunk })));
        const users: Record<string, PublicUser> = {};
        for (const res of results) {
            Object.assign(users, res.data ?? {});
        }
        for (const [id, resolve] of batch) {
            resolve(users[id] ?? null);
        }
    } catch {
        for (const resolve of batch.values()) {
            resolve(null);
        }
    }
}

export function fetchPublicUser(emailOrId: string): Promise<PublicUser | null> {
    return new Promise((resolve) => {
        pending.set(emailOrId, resolve);
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(flushBatch);
        }
    });
}
