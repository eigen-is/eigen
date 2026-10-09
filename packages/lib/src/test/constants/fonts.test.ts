import { describe, expect, test } from 'bun:test';
import { bundledFont, EIGEN_FONT_NAMES, FONT_CATEGORY_MAP } from '../../constants/fonts';

describe('bundledFont', () => {
    test('a bundled font is its own', () => {
        for (const name of EIGEN_FONT_NAMES) expect(bundledFont(name)).toBe(name);
    });

    test('a foreign font maps to the bundled font of its category, in any case and padding', () => {
        expect(bundledFont('Calibri')).toBe('Inter');
        expect(bundledFont('  TIMES NEW ROMAN ')).toBe('Source Serif 4');
        expect(bundledFont('consolas')).toBe('JetBrains Mono');
        expect(bundledFont('Comic Sans MS')).toBe('Excalifont');
    });

    test('an unknown font, or a stack, maps to none', () => {
        expect(bundledFont('Wingdings')).toBeUndefined();
        expect(bundledFont('')).toBeUndefined();
        expect(bundledFont("'Times New Roman', serif")).toBeUndefined();
    });

    test.each([
        ['Aptos', 'Inter'],
        ['Roboto', 'Inter'],
        ['Open Sans', 'Inter'],
        ['Lato', 'Inter'],
        ['Montserrat', 'Inter'],
        ['Oswald', 'Inter'],
        ['Quicksand', 'Inter'],
        ['Noto Sans', 'Inter'],
        ['Liberation Sans', 'Inter'],
        ['Arimo', 'Inter'],
        ['Noto Serif', 'Source Serif 4'],
        ['Liberation Serif', 'Source Serif 4'],
        ['Tinos', 'Source Serif 4'],
        ['Lora', 'Source Serif 4'],
        ['Merriweather', 'Source Serif 4'],
        ['Liberation Mono', 'JetBrains Mono'],
        ['Cousine', 'JetBrains Mono'],
        ['Source Code Pro', 'JetBrains Mono'],
        ['Roboto Mono', 'JetBrains Mono'],
        ['Fira Code', 'JetBrains Mono'],
    ])('the staple %s maps to %s', (name, bundled) => {
        expect(bundledFont(name)).toBe(bundled);
    });

    test('the table is keyed by trimmed lowercase names', () => {
        for (const name of FONT_CATEGORY_MAP.keys()) expect(name).toBe(name.trim().toLowerCase());
    });
});
