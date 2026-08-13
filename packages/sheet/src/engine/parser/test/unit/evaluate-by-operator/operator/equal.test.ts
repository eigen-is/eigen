import { describe, expect, test } from 'bun:test';
import func from '../../../../evaluate-by-operator/operator/equal';

describe('equal operator', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('=');
    });

    test('should compare numbers by value', () => {
        expect(func(1, 1)).toBe(true);
        expect(func(2, 8.8)).toBe(false);
        expect(func(10, 11)).toBe(false);
    });

    test('coerces numbers and numeric strings (Excel parity)', () => {
        expect(func(1, '1')).toBe(true);
        expect(func('1', 1)).toBe(true);
        expect(func('1.0', '1')).toBe(true);
        expect(func('2', 8.8)).toBe(false);
    });

    test('compares text case-insensitively', () => {
        expect(func('A', 'a')).toBe(true);
        expect(func('abc', 'ABC')).toBe(true);
        expect(func('abc', 'abd')).toBe(false);
    });

    test('a non-numeric string is never equal to a number', () => {
        expect(func('abc', 1)).toBe(false);
        expect(func(1, 'abc')).toBe(false);
    });

    test('booleans coerce to numbers', () => {
        expect(func(true, 1)).toBe(true);
        expect(func(false, 0)).toBe(true);
        expect(func(true, 2)).toBe(false);
    });

    test('blank (null/undefined) behaves as empty string', () => {
        expect(func(void 0, void 0)).toBe(true);
        expect(func(null, null)).toBe(true);
        expect(func(void 0, null)).toBe(true);
        expect(func(void 0, '')).toBe(true);
        expect(func(null, '')).toBe(true);
        expect(func(0, void 0)).toBe(false);
        expect(func(0, null)).toBe(false);
    });

    test('an Error operand is never equal', () => {
        expect(func(new Error('#VALUE!'), 5)).toBe(false);
        expect(func(5, new Error('#VALUE!'))).toBe(false);
    });
});
