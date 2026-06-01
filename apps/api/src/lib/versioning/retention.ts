import { parseSnapshotTimestamp } from './timestamp';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

export type RetentionBucket = { intervalMs: number; count: number };
export type RetentionPolicy = { buckets: RetentionBucket[] };
export type SnapshotEntry = { id: string; name: string };

// ~1 year coverage at ≤47 snapshots regardless of write rate.
export const DEFAULT_RETENTION: RetentionPolicy = {
    buckets: [
        { intervalMs: HOUR_MS, count: 24 },
        { intervalMs: DAY_MS, count: 7 },
        { intervalMs: WEEK_MS, count: 4 },
        { intervalMs: MONTH_MS, count: 12 },
    ],
};

export function selectSnapshotsToPrune<T extends SnapshotEntry>(
    items: T[],
    policy: RetentionPolicy,
    now: Date = new Date(),
): T[] {
    const parsed = items
        .map((item) => ({ item, ts: parseSnapshotTimestamp(item.name) }))
        .filter((x): x is { item: T; ts: Date } => x.ts !== null);

    const nowMs = now.getTime();
    const kept = new Set<T>();

    for (const bucket of policy.buckets) {
        const newestPerSlot = new Map<number, { item: T; ts: Date }>();
        for (const p of parsed) {
            const ageMs = Math.max(0, nowMs - p.ts.getTime());
            const slot = Math.floor(ageMs / bucket.intervalMs);
            if (slot >= bucket.count) continue;
            const existing = newestPerSlot.get(slot);
            if (!existing || p.ts.getTime() > existing.ts.getTime()) {
                newestPerSlot.set(slot, p);
            }
        }
        for (const { item } of newestPerSlot.values()) kept.add(item);
    }

    return parsed.filter((p) => !kept.has(p.item)).map((p) => p.item);
}
