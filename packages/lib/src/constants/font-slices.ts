// Every bundled face is cut into slices, each one file that draws a range of characters, as Google Fonts serves its
// fonts. FONT_SLICES lists them, written by the vendoring script beside the fonts.css that loads them in the apps.
// slicesFor picks the slices a text needs, so an export or a downloaded image embeds only those, each as the rule
// fontFaceCss writes. It is a large table, so only code that embeds fonts imports this module, a browser on demand.

import { FONT_SLICES } from './font-slice-data.gen';
import { EMOJI_FAMILIES } from './fonts';

export { FONT_SLICES };

// A slice of one face: its file under assets/fonts/, and the characters it draws as a CSS unicode-range.
export type FontSlice = {
    family: string;
    style: 'normal' | 'italic';
    weight: string;
    file: string;
    unicodeRange: string;
};

// One slice as the @font-face rule that embeds it, its bytes a data: URI.
export function fontFaceCss(slice: FontSlice, dataUri: string): string {
    return `@font-face {
    font-family: "${slice.family}";
    src: url("${dataUri}") format("woff2");
    font-weight: ${slice.weight};
    font-style: ${slice.style};
    font-display: swap;
    unicode-range: ${slice.unicodeRange};
}`;
}

const KEYCAP = 0x20e3;

// Each slice's ranges as start and end pairs, in the order of FONT_SLICES.
const SLICE_RANGES = FONT_SLICES.map((slice) =>
    Int32Array.from(
        slice.unicodeRange.split(', ').flatMap((range) => {
            const [start, end = start] = range.slice(2).split('-');
            return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
        }),
    ),
);

// The slices of these families that draw any of these characters, in the order of FONT_SLICES. A character that only
// joins an emoji to the next one selects no slice, since the slice of the emoji holds it too. The emoji face also
// holds # * and the digits, for a keycap: they select it only beside the keycap mark, and draw in the text face else.
export function slicesFor(codePoints: ReadonlySet<number>, families: Iterable<string>): FontSlice[] {
    const wanted = new Set(families);
    const drawn = Int32Array.from([...codePoints].filter((codePoint) => !isComponent(codePoint))).sort();
    const firstEmoji = codePoints.has(KEYCAP) ? 0 : 0x80;
    return FONT_SLICES.filter(
        (slice, index) =>
            wanted.has(slice.family) &&
            meets(SLICE_RANGES[index], drawn, EMOJI_FAMILIES.includes(slice.family) ? firstEmoji : 0),
    );
}

// The zero width joiner, the variation selectors, the keycap mark and the tag characters of a subdivision flag.
function isComponent(codePoint: number): boolean {
    return (
        codePoint === 0x200d ||
        codePoint === 0xfe0e ||
        codePoint === 0xfe0f ||
        codePoint === KEYCAP ||
        (codePoint >= 0xe0020 && codePoint <= 0xe007f)
    );
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
