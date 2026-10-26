// The docx reader's colour tests: Word's hex as a mark holds it, and whether a fill is one, a light grey, or too light
// or dark for text on Eigen's paper. The run, paragraph and table readers decide a colour mark and a fill through them.

import { linearize } from '@workspace/lib/background';

// Six hex digits, after a '#' some converters write, or nothing: `auto`, a theme name or a typo is an explicit none.
export function hexColor(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return /^#?[0-9a-f]{6}$/i.test(value) ? value.slice(-6).toUpperCase() : '';
}

// A color as a mark holds it, from Word's hex.
export function markColor(hex: string): string {
    return `#${hex.toLowerCase()}`;
}

// White is no fill: Word and Google Docs spell an unshaded cell or paragraph that way too.
export function isFill(fill: string | undefined): boolean {
    return !!fill && fill !== 'FFFFFF';
}

// A light grey, as the editor's code fill and its re-saves are: each channel at least D0 and within 18 of the others.
export function isLightNeutral(fill: string | undefined): boolean {
    if (!fill || !isFill(fill)) return false;
    const channels = [0, 2, 4].map((at) => Number.parseInt(fill.slice(at, at + 2), 16));
    return Math.min(...channels) >= 0xd0 && Math.max(...channels) - Math.min(...channels) <= 0x18;
}

// Contrast below 1.5 against white. On a fill the schema drops, Word draws such text legibly; on Eigen's paper it would
// vanish, so it takes the body color.
export function isLight(hex: string): boolean {
    return 1.05 / (luminance(hex) + 0.05) < 1.5;
}

// White contrasts with it more than black: Word draws auto text on it white.
export function isDark(hex: string): boolean {
    const shade = luminance(hex) + 0.05;
    return 1.05 / shade > shade / 0.05;
}

// WCAG's relative luminance.
function luminance(hex: string): number {
    const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((at) =>
        linearize(Number.parseInt(hex.slice(at, at + 2), 16) / 255),
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
