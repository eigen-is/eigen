import { describe, expect, test } from 'bun:test';
import func from '../../../../../../engine/parser/evaluate-by-operator/operator/divide';

describe('sheet/formula-parser/operator/divide', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('/');
    });

    test('should correctly process values', () => {
        expect(func(10, 2)).toBe(5);
        expect(func('10', 2)).toBe(5);
        expect(func('10', '2')).toBe(5);
        expect(() => func('foo', ' ', 'bar', ' baz')).toThrow('VALUE');
        expect(() => func('foo', 2)).toThrow('VALUE');
        expect(() => func(10, 0)).toThrow('DIV/0');
    });
});
