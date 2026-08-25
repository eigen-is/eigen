import { describe, expect, test } from 'bun:test';
import func from '../../../../../../engine/parser/evaluate-by-operator/operator/not-equal';

describe('not equal operator', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('<>');
    });

    test('should correctly process values', () => {
        expect(func(2, 8.8)).toBe(true);
        expect(func('2', 8.8)).toBe(true);
        // `=` is coercing/case-insensitive (Excel parity), so `<>` is its negation.
        expect(func(1, '1')).toBe(false);
        expect(func('A', 'a')).toBe(false);
        expect(func('abc', 1)).toBe(true);
        expect(func(void 0, null)).toBe(false);
        expect(func(0, null)).toBe(true);
        expect(func(0, void 0)).toBe(true);

        expect(func(1, 1)).toBe(false);
        expect(func(null, null)).toBe(false);
        expect(func(void 0, void 0)).toBe(false);
    });
});
