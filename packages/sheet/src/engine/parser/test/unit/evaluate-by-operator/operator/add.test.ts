import { describe, expect, test } from 'bun:test';
import func from '../../../../evaluate-by-operator/operator/add';

describe('sheet/formula-parser/operator/add', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('+');
    });

    test('should correctly process values', () => {
        expect(func(2, 8.8)).toBe(10.8);
        expect(func('2', 8.8)).toBe(10.8);
        expect(func('2', '8.8')).toBe(10.8);
        expect(func('2', '-8.8', 6, 0.4)).toBe(-0.4000000000000007);
        expect(() => func('foo', ' ', 'bar', ' baz')).toThrow('VALUE');
        expect(() => func('foo', 2)).toThrow('VALUE');
    });

    test('coerces booleans to 1/0 per Excel semantics', () => {
        expect(func(true, 1)).toBe(2);
        expect(func(false, 5)).toBe(5);
        expect(func(true, false, true)).toBe(2);
    });
});
