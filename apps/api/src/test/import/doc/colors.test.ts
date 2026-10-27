import { describe, expect, test } from 'bun:test';
import { hexColor } from '../../../lib/import/doc/colors';

describe('hexColor', () => {
    test.each([
        ['C00000', 'C00000'],
        ['c00000', 'C00000'],
        ['#c00000', 'C00000'],
    ])('%p is %p', (value, hex) => {
        expect(hexColor(value)).toBe(hex);
    });

    // An attribute that is there but holds no six-digit hex is an explicit none.
    test.each(['auto', 'accent1', '##C00000', 'C0000', 'C00000FF', '#C00', ''])('%p is none', (value) => {
        expect(hexColor(value)).toBe('');
    });

    test('a missing attribute is no answer', () => {
        expect(hexColor(undefined)).toBeUndefined();
    });
});
