// Every bundled face is cut into slices, each one file that draws a range of characters, as Google Fonts serves its
// fonts. FONT_SLICES lists them, written by the vendoring script beside the font CSS that loads them in the apps.
// slicesFor picks the slices a text needs, so an export or a downloaded image embeds only those, each as the rule
// fontFaceCss writes. The table is large, so only code that embeds fonts imports this module. In the browser, that
// code loads it with a dynamic import when a download starts.

import { FONT_SLICES } from './font-slice-data.gen';
import { EMOJI_FAMILIES } from './fonts';

export { FONT_SLICES };

// A slice of one face: its file among the font assets, and the characters it draws as a CSS unicode-range.
export type FontSlice = {
    family: string;
    style: 'normal' | 'italic';
    weight: string;
    file: string;
    unicodeRange: string;
};

// The keycap mark, which turns a digit, # or * before it into a keycap emoji.
export const KEYCAP = 0x20e3;

// The characters that only join others into one emoji: the zero width joiner, the emoji variation selector, the keycap
// mark and the tag characters of a subdivision flag. The slice of each emoji holds the ones it needs.
export const EMOJI_COMPONENTS: ReadonlySet<number> = new Set([
    0x200d,
    0xfe0f,
    KEYCAP,
    ...Array.from({ length: 0x60 }, (_, i) => 0xe0020 + i),
]);

// The first character past ASCII. The emoji face holds the ASCII keycap bases, but draws no ASCII character alone.
export const FIRST_NON_ASCII = 0x80;

// One slice as the @font-face rule that loads it from src: a data: URI of its bytes where an export or a downloaded
// image embeds it, or the relative URL the font CSS uses.
export function fontFaceCss(slice: FontSlice, src: string): string {
    return `@font-face {
    font-family: "${slice.family}";
    src: url("${src}") format("woff2");
    font-weight: ${slice.weight};
    font-style: ${slice.style};
    font-display: swap;
    unicode-range: ${slice.unicodeRange};
}`;
}

// Each slice's ranges as start and end pairs, in the order of FONT_SLICES.
const SLICE_RANGES = FONT_SLICES.map((slice) => Int32Array.from(parseUnicodeRange(slice.unicodeRange).flat()));

// The families with italic slices of their own.
const ITALIC_FAMILIES: ReadonlySet<string> = new Set(
    FONT_SLICES.filter((slice) => slice.style === 'italic').map((slice) => slice.family),
);

// The slices of these families that draw any of these characters, in the order of FONT_SLICES. A character that only
// joins an emoji to the next one selects no slice, since the slice of the emoji holds it too. The emoji face also
// holds #, * and the digits for its keycaps. They select it only beside the keycap mark, and otherwise draw in the text
// face.
export function slicesFor(codePoints: ReadonlySet<number>, families: Iterable<string>): FontSlice[] {
    const wanted = new Set(families);
    const drawn = Int32Array.from([...codePoints].filter((codePoint) => !EMOJI_COMPONENTS.has(codePoint))).sort();
    const firstEmoji = codePoints.has(KEYCAP) ? 0 : FIRST_NON_ASCII;
    return FONT_SLICES.filter(
        (slice, index) =>
            wanted.has(slice.family) &&
            meets(SLICE_RANGES[index], drawn, EMOJI_FAMILIES.includes(slice.family) ? firstEmoji : 0),
    );
}

// The style of the slices that draw a family in a CSS font-style. An italic or oblique run draws in the family's italic
// slices where it has them. Elsewhere it draws in the upright ones, which the browser slants.
export function sliceStyle(family: string, fontStyle: string): FontSlice['style'] {
    return fontStyle !== 'normal' && ITALIC_FAMILIES.has(family) ? 'italic' : 'normal';
}

// A CSS unicode-range, such as "U+0-FF, U+131", as its ranges' first and last characters.
export function parseUnicodeRange(unicodeRange: string): [number, number][] {
    return unicodeRange.split(',').map((part) => {
        const [start, end = start] = part.trim().slice(2).split('-');
        return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
    });
}

// Whether a sorted list holds a character of the ranges at or above `from`, by a binary search per range.
function meets(ranges: Int32Array, sorted: Int32Array, from: number): boolean {
    for (let i = 0; i < ranges.length; i += 2) {
        const start = Math.max(ranges[i], from);
        let low = 0;
        let high = sorted.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (sorted[middle] < start) low = middle + 1;
            else high = middle;
        }
        if (low < sorted.length && sorted[low] <= ranges[i + 1]) return true;
    }
    return false;
}
