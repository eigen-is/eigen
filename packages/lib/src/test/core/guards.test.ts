import { describe, expect, test } from 'bun:test';
import { isRecord, readNumberIn } from '../../core/guards';

describe('isRecord', () => {
    test('a plain object is a record, and an array, null or a primitive is not', () => {
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord('a')).toBe(false);
    });
});

describe('readNumberIn', () => {
    test('a number in the range reads as it is', () => {
        expect(readNumberIn(3.5, 1, 6)).toBe(3.5);
        expect(readNumberIn(1, 1, 6)).toBe(1);
        expect(readNumberIn(6, 1, 6)).toBe(6);
    });

    test('a number outside the range reads as the nearest bound', () => {
        expect(readNumberIn(-40, 1, 6)).toBe(1);
        expect(readNumberIn(1e300, 1, 6)).toBe(6);
        expect(readNumberIn(-1e300, -10, 10)).toBe(-10);
    });

    test('anything but a finite number reads as null', () => {
        for (const value of [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            '3',
            null,
            undefined,
            {},
            [],
        ])
            expect(readNumberIn(value, 1, 6)).toBeNull();
    });

    test('a range whose min passes its max reads as the max, as Math.min over Math.max gives', () => {
        expect(readNumberIn(5, 10, 2)).toBe(2);
        expect(readNumberIn(-5, 10, 2)).toBe(2);
    });
});
