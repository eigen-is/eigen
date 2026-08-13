// Shared TanStack Query `staleTime` windows, in milliseconds. One home for the cache
// durations so "which queries cache for N minutes" is a single grep. Sentinel values stay
// inline at their call sites: `Infinity` (never refetch) and `0` (always stale) read clearly
// on their own and aren't tunable durations.
export const STALE_TIME = {
    THIRTY_SECONDS: 30_000,
    ONE_MINUTE: 60_000,
    TWO_MINUTES: 2 * 60_000,
    FIVE_MINUTES: 5 * 60_000,
} as const;
