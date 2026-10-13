// A label's width without a DOM, for reserving room only (chart axes, legends, ellipsizing): advances summed,
// no kerning or shaping, so it runs a little off the browser's and placement still goes through text-anchor.

import { TEXT_WIDTHS } from './text-width-data';
import { DEFAULT_FONT_FAMILY } from './types';

// One face's advances in 1/1000 em, one per TEXT_WIDTH_RANGES code point in order, and the advance of every
// other code point.
export type FaceWidths = { advances: readonly number[]; fallback: number };

// The code points the width table holds: Basic Latin's printable run, then Latin-1's.
export const TEXT_WIDTH_RANGES = [
    [0x20, 0x7e],
    [0xa0, 0xff],
] as const;

export function measureLabel(text: string, fontFamily: string, fontSize: number, bold: boolean): number {
    const font = TEXT_WIDTHS[fontFamily] ?? TEXT_WIDTHS[DEFAULT_FONT_FAMILY];
    // Excalifont ships no bold face; the browser fakes one at the regular advances.
    const face = (bold && font.bold) || font.regular;
    let units = 0;
    for (const char of text) {
        // An astral character's high surrogate lies past the table, as its code point does.
        const code = char.charCodeAt(0);
        let advance = face.fallback;
        let index = 0;
        for (const [first, last] of TEXT_WIDTH_RANGES) {
            if (code >= first && code <= last) {
                advance = face.advances[index + code - first];
                break;
            }
            index += last - first + 1;
        }
        units += advance;
    }
    return (units / 1000) * fontSize;
}
