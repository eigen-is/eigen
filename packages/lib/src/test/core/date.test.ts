// Times read on a 24-hour clock with two-digit hours, the shape the event dialog's time field takes.
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
});

describe('formatFullDateTime', () => {
    test('a date and a 24-hour time', () => {
        expect(formatFullDateTime(new Date(2026, 0, 5, 14, 30))).toBe('5 Jan 2026 at 14:30');
    });
});
