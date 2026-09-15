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

    test('a blank operand reads as 0', () => {
        expect(() => func(1, undefined)).toThrow('DIV/0');
        expect(func(undefined, 2)).toBe(0);
    });

    test('a zero divisor is #DIV/0! whatever the dividend', () => {
        expect(() => func(0, 0)).toThrow('DIV/0');
        expect(() => func(10, '0')).toThrow('DIV/0');
        expect(() => func(10, false)).toThrow('DIV/0');
        expect(() => func(100, 5, 0)).toThrow('DIV/0');
    });
});
