import { describe, expect, test } from 'bun:test';
import func from '../../../../../../engine/parser/evaluate-by-operator/operator/multiply';

describe('sheet/formula-parser/operator/multiply', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('*');
    });

    test('should correctly process values', () => {
        expect(func(2, 8.8)).toBe(17.6);
        expect(func('2', 8.8)).toBe(17.6);
        expect(func('2', '8.8')).toBe(17.6);
        expect(() => func('foo', ' ', 'bar', ' baz')).toThrow('VALUE');
        expect(() => func('foo', 2)).toThrow('VALUE');
    });

    test('coerces booleans to 1/0 per Excel semantics', () => {
        expect(func(true, 5)).toBe(5);
        expect(func(false, 5)).toBe(0);
        expect(func(true, true, 3)).toBe(3);
    });
});
