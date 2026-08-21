import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { Semaphore } from '../../utils/semaphore';
import { pullHomeSize } from '../home/home-relay';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 4;

let cache: { at: number; ids: string; data: Record<string, HomeSizeResponse> } | null = null;
let inFlight: { ids: string; promise: Promise<Record<string, HomeSizeResponse>> } | null = null;

// Sizing a user means instantiating their Home (self-evicting after idle), so results are computed
// a few at a time and cached; a single broken home is skipped, not a 500 for the page. The cache is
// keyed by the exact id set it was computed for — a call for a different set bypasses the TTL and
// recomputes, so a shrunk/grown user list never serves the wrong rows. Concurrent calls for the same
// set still share one in-flight computation.
export async function getAllUsersUsage(userIds: string[]): Promise<Record<string, HomeSizeResponse>> {
    const ids = [...userIds].sort().join(',');
    if (cache && cache.ids === ids && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
    if (inFlight && inFlight.ids === ids) return inFlight.promise;
    const promise = (async () => {
        const data: Record<string, HomeSizeResponse> = {};
        const sem = new Semaphore(CONCURRENCY);
        await Promise.all(
            userIds.map((userId) =>
                sem.run(async () => {
                    try {
                        data[userId] = await pullHomeSize(userId);
                    } catch (error) {
                        console.error(`[admin-usage] failed to size home ${userId}:`, error);
                    }
                }),
            ),
        );
        cache = { at: Date.now(), ids, data };
        return data;
    })();
    inFlight = { ids, promise };
    promise.finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
    });
    return promise;
}
