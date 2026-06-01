import { describe, expect, test } from 'bun:test';
import {
    DAY_MS,
    DEFAULT_RETENTION,
    HOUR_MS,
    type RetentionPolicy,
    selectSnapshotsToPrune,
} from '../lib/versioning/retention';
import { formatSnapshotTimestamp, parseSnapshotTimestamp } from '../lib/versioning/timestamp';

describe('snapshot timestamp', () => {
    test('formats Date to filename-safe ISO with .db extension', () => {
        expect(formatSnapshotTimestamp(new Date('2026-05-31T13:45:00.123Z'))).toBe('2026-05-31T13-45-00-123Z.db');
    });
    test('round-trips', () => {
        const d = new Date('2026-05-31T13:45:00.123Z');
        expect(parseSnapshotTimestamp(formatSnapshotTimestamp(d))?.toISOString()).toBe(d.toISOString());
    });
    test('returns null for non-snapshot names', () => {
        expect(parseSnapshotTimestamp('data.db')).toBeNull();
        expect(parseSnapshotTimestamp('2026-05-31T13-45-00-123Z')).toBeNull();
    });
});

describe('retention pruning (time-bucketed)', () => {
    const now = new Date('2026-05-31T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const fmt = (d: Date) => `${d.toISOString().replace(/[:.]/g, '-')}.db`;
    const mk = (offsets: number[]) => offsets.map((ms, i) => ({ id: `s${i}`, name: fmt(ago(ms)) }));

    test('hourly bucket: keep newest per hour slot', () => {
        const items = mk([10 * 60_000, 20 * 60_000, 30 * 60_000]);
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        expect(
            selectSnapshotsToPrune(items, policy, now)
                .map((p) => p.id)
                .sort(),
        ).toEqual(['s1', 's2']);
    });

    test('multi-bucket: hourly + daily', () => {
        const items = mk([30 * 60_000, 90 * 60_000, 25 * HOUR_MS, 2 * DAY_MS, 8 * DAY_MS]);
        const policy: RetentionPolicy = {
            buckets: [
                { intervalMs: HOUR_MS, count: 24 },
                { intervalMs: DAY_MS, count: 7 },
            ],
        };
        expect(selectSnapshotsToPrune(items, policy, now).map((p) => p.id)).toEqual(['s4']);
    });

    test('overlap: same snapshot kept by multiple buckets, stored once', () => {
        const items = mk([30 * 60_000, 4 * HOUR_MS]);
        const policy: RetentionPolicy = {
            buckets: [
                { intervalMs: HOUR_MS, count: 24 },
                { intervalMs: DAY_MS, count: 7 },
            ],
        };
        expect(selectSnapshotsToPrune(items, policy, now)).toEqual([]);
    });

    test('default policy keeps 300d-old, prunes 400d-old', () => {
        expect(selectSnapshotsToPrune(mk([300 * DAY_MS]), DEFAULT_RETENTION, now)).toEqual([]);
        expect(selectSnapshotsToPrune(mk([400 * DAY_MS]), DEFAULT_RETENTION, now)).toHaveLength(1);
    });

    test('sparse: 1/week is fully kept', () => {
        const items = mk([1 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 21 * DAY_MS]);
        expect(selectSnapshotsToPrune(items, DEFAULT_RETENTION, now)).toEqual([]);
    });

    test('dense: 50 in last hour → 1 kept', () => {
        const items = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: fmt(ago(i * 60_000)) }));
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        const pruned = selectSnapshotsToPrune(items, policy, now);
        expect(pruned).toHaveLength(49);
        expect(pruned.map((p) => p.id)).not.toContain('s0');
    });

    test('ignores non-snapshot files', () => {
        const items = [
            { id: 'a', name: fmt(ago(30 * 60_000)) },
            { id: 'b', name: 'garbage.db' },
            { id: 'c', name: fmt(ago(2 * HOUR_MS)) },
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 1 }] };
        expect(selectSnapshotsToPrune(items, policy, now).map((p) => p.id)).toEqual(['c']);
    });
});
