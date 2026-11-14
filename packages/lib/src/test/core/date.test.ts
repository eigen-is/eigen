import { describe, expect, test } from 'bun:test';
import { formatFullDateTime, formatTime } from '../../core/date';

describe('formatTime', () => {
    test('a morning hour keeps its leading zero and its minutes', () => {
        expect(formatTime(new Date(2026, 10, 14, 9, 0))).toBe('09:00');
        expect(formatTime(new Date(2026, 10, 14, 9, 5))).toBe('09:05');
    });

    test('an afternoon hour runs past twelve', () => {
        expect(formatTime(new Date(2026, 10, 14, 14, 30))).toBe('14:30');
    });

    test('noon and midnight read 12:00 and 00:00', () => {
        expect(formatTime(new Date(2026, 10, 14, 12, 0))).toBe('12:00');
        expect(formatTime(new Date(2026, 10, 14, 0, 0))).toBe('00:00');
    });

    test('a time zone reads the clock there, on the same 24-hour shape', () => {
        const halfPastMidnightUtc = new Date(Date.UTC(2026, 10, 14, 0, 30));
        expect(formatTime(halfPastMidnightUtc, 'UTC')).toBe('00:30');
        expect(formatTime(halfPastMidnightUtc, 'America/New_York')).toBe('19:30');
        expect(formatTime(new Date(Date.UTC(2026, 10, 14, 15, 42)), 'Asia/Kolkata')).toBe('21:12');
    });
});

describe('formatFullDateTime', () => {
    test('a date and a 24-hour time', () => {
        expect(formatFullDateTime(new Date(2026, 0, 5, 14, 30))).toBe('5 Jan 2026 at 14:30');
    });
});
