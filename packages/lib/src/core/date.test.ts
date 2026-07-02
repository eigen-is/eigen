import { describe, expect, test } from 'bun:test';
import { formatEventWhen } from './date';

describe('formatEventWhen', () => {
    const start = new Date('2026-09-10T09:00:00Z');
    const end = new Date('2026-09-10T10:00:00Z');

    test('a valid IANA zone shifts the wall-clock time', () => {
        // Sept 2026 is CEST (UTC+2), so 09:00Z renders as 11:00.
        expect(formatEventWhen(start, end, false, 'Europe/Amsterdam')).toContain('11:00');
    });

    test('a non-IANA zone (pre-normalization stored TZID) degrades to UTC instead of throwing', () => {
        expect(formatEventWhen(start, end, false, 'W. Europe Standard Time')).toBe(
            formatEventWhen(start, end, false, 'UTC'),
        );
    });
});
