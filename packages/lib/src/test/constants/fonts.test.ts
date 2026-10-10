import { describe, expect, test } from 'bun:test';
import { bundledFont, bundledFontOfCategory, EIGEN_FONT_NAMES } from '../../constants/fonts';

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

    test('a bundled font maps to itself in any case and padding', () => {
        for (const name of EIGEN_FONT_NAMES) expect(bundledFont(` ${name.toUpperCase()} `)).toBe(name);
    });
});

describe('bundledFontOfCategory', () => {
    test.each([
        ['sans-serif', 'Inter'],
        ['serif', 'Source Serif 4'],
        ['monospace', 'JetBrains Mono'],
        ['hand-drawn', 'Excalifont'],
    ] as const)('%s is drawn in %s', (category, name) => {
        expect(bundledFontOfCategory(category)).toBe(name);
    });
});
