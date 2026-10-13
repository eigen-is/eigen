// A label's width without a DOM, for reserving room only (chart axes, legends, ellipsizing): advances summed,
// no kerning or shaping, so it runs a little off the browser's and placement still goes through text-anchor.

import { TEXT_WIDTHS } from './text-width-data';
import { DEFAULT_FONT_FAMILY } from './types';

const LATIN1_START = 0xa0;
const BASIC_LATIN_COUNT = 0x7e - 0x20 + 1;

export function measureLabel(text: string, fontFamily: string, fontSize: number, bold: boolean): number {
    const font = TEXT_WIDTHS[fontFamily] ?? TEXT_WIDTHS[DEFAULT_FONT_FAMILY];
    // Excalifont ships no bold face; the browser fakes one at the regular advances.
    const face = (bold && font.bold) || font.regular;
    let units = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        const index =
            code >= 0x20 && code <= 0x7e
                ? code - 0x20
                : code >= LATIN1_START && code <= 0xff
                  ? BASIC_LATIN_COUNT + code - LATIN1_START
                  : -1;
        units += index < 0 ? face.fallback : face.advances[index];
    }
    return (units / 1000) * fontSize;
}
