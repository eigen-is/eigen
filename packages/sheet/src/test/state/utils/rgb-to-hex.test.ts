import { describe, expect, test } from 'bun:test';
import { rgbToHex } from '../../../state/utils';

describe('rgbToHex', () => {
    test.each([
        ['rgb(255, 0, 0)', '#ff0000'],
        ['rgba(0, 0, 255, 0.5)', '#0000ff'],
        ['rgb(0 128 255)', '#0080ff'],
    ])('%p is %p, its alpha dropped', (color, hex) => {
        expect(rgbToHex(color)).toBe(hex);
    });

    // The filter and the toolbar compare what comes back, so a color that is no rgb() stays as it was written.
    test.each(['rgba(nonsense)', 'rgb(300, 0, 0)', '#ff0000'])('%p comes back as it is', (color) => {
        expect(rgbToHex(color)).toBe(color);
    });
});
