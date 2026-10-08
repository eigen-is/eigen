import { describe, expect, test } from 'bun:test';
import { cssColorToHex } from '../../lib/export/colors';

describe('cssColorToHex', () => {
    test.each([
        ['#c00000', 'C00000'],
        ['#ABCDEF', 'ABCDEF'],
        ['#f80', 'FF8800'],
        ['rgb(0, 128, 255)', '0080FF'],
        ['rgb(0 128 255)', '0080FF'],
        ['rgba(255, 0, 0, 0.5)', 'FF0000'],
        ['rgb(0 128 255 / 50%)', '0080FF'],
        [' #1a1a2e ', '1A1A2E'],
    ])('%s is %s', (color, hex) => {
        expect(cssColorToHex(color)).toBe(hex);
    });

    test.each([
        'red',
        'transparent',
        '#12345',
        '#ff000080',
        'rgb(300, 0, 0)',
        'var(--color-primary)',
        '',
        // Fully transparent: no fill, not a black one.
        'rgba(0, 0, 0, 0)',
        'rgba(0 0 0 / 0)',
        'rgba(255, 0, 0, 0%)',
    ])('%s is no color Office can hold', (color) => {
        expect(cssColorToHex(color)).toBeUndefined();
    });
});
