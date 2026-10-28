// The storage each user's home takes, for the admin's Users page. A home is sized from its folder and databases
// through pullHomeSize, without booting it. That is still disk work, so a few homes are sized at once and the
// result is cached for a few minutes.

import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { Semaphore } from '../../utils/semaphore';
import { pullHomeSize } from '../home/home-relay';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 4;

let cache: { at: number; ids: string; data: Record<string, HomeSizeResponse> } | null = null;
let inFlight: { ids: string; promise: Promise<Record<string, HomeSizeResponse>> } | null = null;

// A home that fails to size is left out, so one broken home does not fail the page. The cache holds one exact set
// of users: a call for another set computes again, so a list that grew or shrank never gets the wrong rows. Calls
// for the same set at the same time share one computation.
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
