// Decides which saved versions of a document's data.db a prune deletes. A version stays while it is the newest of its
// hour, day, week or month among the most recent ones that hold a version, so recent work keeps a dense trail and older
// work a thin one. The snapshot step calls it after each new version.

import { parseSnapshotTimestamp } from './timestamp';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

export type RetentionBucket = { intervalMs: number; count: number };
export type RetentionPolicy = { buckets: RetentionBucket[] };
export type SnapshotEntry = { id: string; name: string };

export const DEFAULT_RETENTION: RetentionPolicy = {
    buckets: [
        { intervalMs: HOUR_MS, count: 24 },
        { intervalMs: DAY_MS, count: 7 },
        { intervalMs: WEEK_MS, count: 4 },
        { intervalMs: MONTH_MS, count: 12 },
    ],
};

export function selectSnapshotsToPrune<T extends SnapshotEntry>(items: readonly T[], policy: RetentionPolicy): T[] {
    const parsed = items
        .map((item) => ({ item, ts: parseSnapshotTimestamp(item.name)?.getTime() }))
        .filter((x): x is { item: T; ts: number } => x.ts !== undefined);

    const kept = new Set<T>();
    for (const { intervalMs, count } of policy.buckets) {
        const newestPerBucket = new Map<number, { item: T; ts: number }>();
        for (const p of parsed) {
            const bucket = Math.floor(p.ts / intervalMs);
            const existing = newestPerBucket.get(bucket);
            if (!existing || p.ts > existing.ts) newestPerBucket.set(bucket, p);
        }
        const newestBuckets = [...newestPerBucket].sort(([a], [b]) => b - a).slice(0, count);
        for (const [, { item }] of newestBuckets) kept.add(item);
    }

    return parsed.filter((p) => !kept.has(p.item)).map((p) => p.item);
}
