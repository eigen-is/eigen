import { describe, expect, test } from 'bun:test';
import {
    bundledFont,
    bundledFontOfCategory,
    bundledFontOfStack,
    EIGEN_FONT_NAMES,
    EMOJI_FAMILIES,
    fontNameToCss,
    getFontFamily,
    getFontName,
    MATH_FAMILIES,
    MATH_FONT_STACK,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    nextFontSize,
    readCssFontSize,
    readFontSize,
    TEXT_FALLBACK_FAMILIES,
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

describe('getFontFamily', () => {
    // The order of the fallbacks never decides a glyph: each slice's range is disjoint from the other families'.
    test('a family, then the emoji and CJK faces, then the system faces and the generic family', () => {
        expect(getFontFamily('Inter')).toBe(
            "'Inter', 'Eigen Emoji', 'Noto Sans SC', 'Noto Sans KR', ui-sans-serif, system-ui, sans-serif",
        );
        expect(getFontFamily('Source Serif 4')).toBe(
            "'Source Serif 4', 'Eigen Emoji', 'Noto Sans SC', 'Noto Sans KR', Georgia, 'Times New Roman', serif",
        );
        expect(fontNameToCss('Inter')).toBe(getFontFamily('Inter'));
    });

    // The emoji face holds the digits, # and * for its keycaps, so a font the browser lacks must not fall to it.
    test("an unknown font falls back on its category's bundled stack, else the document font's", () => {
        expect(getFontFamily('Georgia')).toBe(`'Georgia', ${getFontFamily('Source Serif 4')}`);
        expect(getFontFamily('Bell MT')).toBe(`'Bell MT', ${getFontFamily('Inter')}`);
    });

    test('the lists of fallback families split the registry by kind', () => {
        expect(TEXT_FALLBACK_FAMILIES).toEqual(['Eigen Emoji', 'Noto Sans SC', 'Noto Sans KR']);
        expect(EMOJI_FAMILIES).toEqual(['Eigen Emoji']);
        expect(MATH_FAMILIES).toEqual(['New Computer Modern Math']);
    });

    // Only a formula draws in the math face, which covers Latin too.
    test('no text stack names the math face, and the math stack names only it', () => {
        for (const name of EIGEN_FONT_NAMES) expect(getFontFamily(name)).not.toContain(MATH_FAMILIES[0]);
        expect(MATH_FONT_STACK).toBe("'New Computer Modern Math', math");
    });

    test('a stored stack, short or long, reads as its name and draws as it is stored', () => {
        for (const name of EIGEN_FONT_NAMES) {
            expect(getFontName(getFontFamily(name))).toBe(name);
        }
        expect(getFontName("'Source Serif 4', serif")).toBe('Source Serif 4');
        expect(getFontName('"JetBrains Mono", monospace')).toBe('JetBrains Mono');
        expect(fontNameToCss("'Source Serif 4', serif")).toBe("'Source Serif 4', serif");
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
