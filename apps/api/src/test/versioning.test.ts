import { describe, expect, test } from 'bun:test';
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
