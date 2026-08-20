import type { HomeSizeResponse } from '@workspace/lib/types/settings';
import { pullHomeSize } from '../home/home-relay';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENCY = 4;

let cache: { at: number; data: Record<string, HomeSizeResponse> } | null = null;
let inFlight: Promise<Record<string, HomeSizeResponse>> | null = null;

// Sizing a user means instantiating their Home (self-evicting after idle), so results are
// computed a few at a time and cached; a single broken home is skipped, not a 500 for the page.
export async function getAllUsersUsage(userIds: string[]): Promise<Record<string, HomeSizeResponse>> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        const data: Record<string, HomeSizeResponse> = {};
        const queue = [...userIds];
        await Promise.all(
            Array.from({ length: CONCURRENCY }, async () => {
                for (let userId = queue.shift(); userId; userId = queue.shift()) {
                    try {
                        data[userId] = await pullHomeSize(userId);
                    } catch (error) {
                        console.error(`[admin-usage] failed to size home ${userId}:`, error);
                    }
                }
            }),
        );
        cache = { at: Date.now(), data };
        return data;
    })().finally(() => {
        inFlight = null;
    });
    return inFlight;
}
