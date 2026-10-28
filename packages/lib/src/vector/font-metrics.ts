// Per-font metrics: the vertical ones place SVG <text> baselines in the pure renderer, the
// widest digit sizes a sheet's xlsx column unit (sheets/fonts.ts). Keyed by EIGEN_FONTS name;
// values extracted from the shipped faces (fonttools). Never stored per element — derived at render.
// `getVerticalOffset` replicates Excalidraw's alphabetic-baseline formula.

import { fontLineHeight } from '../constants/fonts';
import { DEFAULT_FONT_FAMILY } from './types';

type FontMetrics = {
    unitsPerEm: number; // Inter is 2048; the others 1000 — always normalize by this
    ascender: number;
    descender: number; // negative
    lineHeight: number; // unitless multiplier of fontSize
    digitWidth: number; // the widest of 0–9's advances
};

// A line is the face's single line (EIGEN_FONTS), but Excalifont's: the canvas draws it at Excalidraw's 1.25, under the
// face's 1.26, and every drawing's text is laid out at that.
const FONT_METRICS: Record<string, FontMetrics> = {
    Inter: { unitsPerEm: 2048, ascender: 1984, descender: -494, lineHeight: fontLineHeight('Inter'), digitWidth: 1323 },
    'Source Serif 4': {
        unitsPerEm: 1000,
        ascender: 1036,
        descender: -335,
        lineHeight: fontLineHeight('Source Serif 4'),
        digitWidth: 500,
    },
    'JetBrains Mono': {
        unitsPerEm: 1000,
        ascender: 1020,
        descender: -300,
        lineHeight: fontLineHeight('JetBrains Mono'),
        digitWidth: 600,
    },
    Excalifont: { unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25, digitWidth: 700 },
};

export function getFontMetrics(fontFamily: string): FontMetrics {
    return FONT_METRICS[fontFamily] ?? FONT_METRICS[DEFAULT_FONT_FAMILY];
}

export function getLineHeightPx(fontFamily: string, fontSize: number): number {
    return fontSize * getFontMetrics(fontFamily).lineHeight;
}

// Distance from a line's top to its alphabetic baseline, so `y = i*lineHeightPx +
// verticalOffset` places each <text> line's baseline correctly.
export function getVerticalOffset(fontFamily: string, fontSize: number, lineHeightPx: number): number {
    const { unitsPerEm, ascender, descender } = getFontMetrics(fontFamily);
    const fontSizeEm = fontSize / unitsPerEm;
    const lineGap = (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;
    return fontSizeEm * ascender + lineGap;
}
