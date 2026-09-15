import { describe, expect, test } from 'bun:test';
import func from '../../../../../../engine/parser/evaluate-by-operator/operator/ampersand';

describe('sheet/formula-parser/operator/ampersand', () => {
    test('should set SYMBOL const', () => {
        expect(func.SYMBOL).toBe('&');
    });

    test('should correctly process values', () => {
        expect(func('foo', 'bar')).toBe('foobar');
        expect(func(1, 2)).toBe('12');
        expect(func('a', null, 'b')).toBe('ab');
        expect(func('', '')).toBe('');
    });

    test('renders booleans upper-case per Excel semantics', () => {
        expect(func(true, 'x')).toBe('TRUEx');
        expect(func('a', false)).toBe('aFALSE');
        expect(func(true, false)).toBe('TRUEFALSE');
    });

    test('renders a Date as its serial, not as Date.toString()', () => {
        expect(func(new Date(2026, 0, 5), 'x')).toBe('46027x');
    });
});
