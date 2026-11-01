// Reads back which font slices an export embeds, so a suite pins the files by name. A rule is matched to its slice by
// family, style and range, and one that matches no slice, such as a whole face, reads as "unknown".

import type { FontSlice } from '@workspace/lib/constants/font-slices';
import { FONT_SLICES } from '@workspace/lib/constants/font-slices';

// The file of each @font-face rule in the document, in its order.
export function embeddedSliceFiles(html: string): string[] {
    return html
        .split('@font-face')
        .slice(1)
        .map((rule) => {
            const field = (name: string) => rule.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const family = field('font-family')?.replace(/"/g, '');
            const slice = FONT_SLICES.find(
                (candidate) =>
                    candidate.family === family &&
                    candidate.style === field('font-style') &&
                    candidate.unicodeRange === field('unicode-range'),
            );
            return slice?.file ?? 'unknown';
        });
}

// The slice of a family that draws a character, as the range data says.
export function sliceFileOf(family: string, char: string, style: FontSlice['style'] = 'normal'): string {
    const codePoint = char.codePointAt(0) ?? 0;
    const slice = FONT_SLICES.find(
        (candidate) =>
            candidate.family === family &&
            candidate.style === style &&
            candidate.unicodeRange.split(', ').some((range) => {
                const [start, end = start] = range.slice(2).split('-');
                return Number.parseInt(start, 16) <= codePoint && codePoint <= Number.parseInt(end, 16);
            }),
    );
    if (!slice) throw new Error(`no ${family} slice draws ${char}`);
    return slice.file;
}
