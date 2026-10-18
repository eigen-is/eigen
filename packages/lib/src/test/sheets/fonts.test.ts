import { describe, expect, test } from 'bun:test';
import { cellFontName, SHEET_DEFAULT_DIGIT_WIDTH } from '../../sheets/fonts';

describe('cellFontName', () => {
    test('an index names the bundled font at it', () => {
        expect(cellFontName(0)).toBe('Inter');
        expect(cellFontName(2)).toBe('JetBrains Mono');
        expect(cellFontName(9)).toBeUndefined();
    });

    test('a name is itself, a stored stack its first family in the bundled spelling', () => {
        expect(cellFontName('Georgia')).toBe('Georgia');
        expect(cellFontName("'jetbrains mono', sans-serif")).toBe('JetBrains Mono');
        expect(cellFontName('"Source Serif 4", serif')).toBe('Source Serif 4');
    });

    test('a numeric string is a name, not an index', () => {
        expect(cellFontName('2')).toBe('2');
    });

    test('no font is none', () => {
        expect(cellFontName(undefined)).toBeUndefined();
        expect(cellFontName('')).toBeUndefined();
    });
});

test("the column unit is Inter's widest digit at 10pt, in whole pixels", () => {
    expect(SHEET_DEFAULT_DIGIT_WIDTH).toBe(9);
});
