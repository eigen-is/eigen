import { describe, expect, test } from 'bun:test';
import {
    bundledFont,
    bundledFontOfCategory,
    bundledFontOfStack,
    EIGEN_FONT_NAMES,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    nextFontSize,
    readCssFontSize,
    readFontSize,
} from '../../constants/fonts';

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

describe('font sizes', () => {
    test("a size lands in Google's 1 to 400 pt, in Word's half points", () => {
        expect(readFontSize(12)).toBe(12);
        expect(readFontSize(10.3)).toBe(10.5);
        expect(readFontSize(0)).toBe(MIN_FONT_SIZE);
        expect(readFontSize(1e6)).toBe(MAX_FONT_SIZE);
    });

    // A peer writes the attribute, so a string would otherwise reach a style attribute.
    test.each([['12'], ['12pt; position: fixed'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined]])(
        '%p is no size',
        (value) => {
            expect(readFontSize(value)).toBeUndefined();
        },
    );

    test('a step is a point, and stops at the ends of the range', () => {
        expect(nextFontSize(11, 1)).toBe(12);
        expect(nextFontSize(10.5, -1)).toBe(9.5);
        expect(nextFontSize(MAX_FONT_SIZE, 1)).toBe(MAX_FONT_SIZE);
        expect(nextFontSize(MIN_FONT_SIZE, -1)).toBe(MIN_FONT_SIZE);
    });
});

describe('readCssFontSize', () => {
    test('pt reads as pt and px at 96 dpi, on the half-point grid', () => {
        expect(readCssFontSize('14pt')).toBe(14);
        expect(readCssFontSize('12.0pt')).toBe(12);
        expect(readCssFontSize('16px')).toBe(12);
        expect(readCssFontSize('34.6667px')).toBe(26);
    });

    // Relative to what the source drew around it, so no size of its own.
    test.each([['1.2em'], ['120%'], ['large'], ['']])('%p is no size', (value) => {
        expect(readCssFontSize(value)).toBeUndefined();
    });
});

describe('bundledFontOfStack', () => {
    test.each([
        ['Georgia,serif', 'Source Serif 4'],
        ['"Times New Roman", serif', 'Source Serif 4'],
        ["'Source Serif 4', serif", 'Source Serif 4'],
        ['Wingdings, "Courier New", monospace', 'JetBrains Mono'],
        ['Calibri', 'Inter'],
    ])('%s is drawn in %s', (stack, bundled) => {
        expect(bundledFontOfStack(stack)).toBe(bundled);
    });

    test('a stack of unknown and generic families maps to none', () => {
        expect(bundledFontOfStack('Wingdings, sans-serif')).toBeUndefined();
        expect(bundledFontOfStack('')).toBeUndefined();
    });
});
