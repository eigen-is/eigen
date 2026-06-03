import { parseSnapshotTimestamp } from './timestamp';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

export type RetentionBucket = { intervalMs: number; count: number };
export type RetentionPolicy = { buckets: RetentionBucket[] };
export type SnapshotEntry = { id: string; name: string };

// ≤47 snapshots: hourly for the last 24 edited hours, then daily (7), weekly (4),
// monthly (12). Granularity tracks editing time, not wall-clock, so a file worked on
// in bursts keeps an hourly trail of its actual sessions.
export const DEFAULT_RETENTION: RetentionPolicy = {
    buckets: [
        { intervalMs: HOUR_MS, count: 24 },
        { intervalMs: DAY_MS, count: 7 },
        { intervalMs: WEEK_MS, count: 4 },
        { intervalMs: MONTH_MS, count: 12 },
    ],
};

// Keep the newest snapshot in each of the `count` most recent buckets per tier,
// where a bucket is floor(timestamp / intervalMs). Buckets are keyed by the
// snapshot's own time, so they never shift: "newest per bucket" stays stable under
// the incremental pruning snapshotContainerDataDb runs after every snapshot, and a
// completed hour's representative is locked in instead of being displaced by the next
// edit. (The borg/restic keep-hourly/daily/… model, anchored to the most recent
// snapshots rather than wall-clock now. See scripts/version-retention-sim.ts.)
export function selectSnapshotsToPrune<T extends SnapshotEntry>(items: T[], policy: RetentionPolicy): T[] {
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
        for (const bucket of [...newestPerBucket.keys()].sort((a, b) => b - a).slice(0, count)) {
            kept.add(newestPerBucket.get(bucket)!.item);
        }
    }

    return parsed.filter((p) => !kept.has(p.item)).map((p) => p.item);
}
