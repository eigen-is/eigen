import { publicApi } from '@workspace/lib/api';
import type { PublicUser } from '../../types/public';

type PendingRequest = {
    resolve: (user: PublicUser) => void;
    reject: (error: Error) => void;
};

let pending = new Map<string, PendingRequest>();
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
        const { resolve, reject } = batch.get(id)!;
        try {
            const res = await publicApi.user({ emailOrId: id }).get();
            if (res.data) resolve(res.data);
            else reject(new Error('User not found'));
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
        }
        return;
    }

    // Multiple IDs — batch POST
    try {
        const res = await publicApi.users.post({ ids });
        const users = (res.data ?? {}) as Record<string, PublicUser>;
        for (const [id, callbacks] of batch) {
            const user = users[id];
            if (user) callbacks.resolve(user);
            else callbacks.reject(new Error('User not found'));
        }
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        for (const callbacks of batch.values()) {
            callbacks.reject(error);
        }
    }
}

export function fetchPublicUser(emailOrId: string): Promise<PublicUser> {
    return new Promise((resolve, reject) => {
        pending.set(emailOrId, { resolve, reject });
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(flushBatch);
        }
    });
}
