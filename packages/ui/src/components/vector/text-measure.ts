// Measures the plain text of a vector element on a canvas, in the font it is drawn in, such as an arrow label or a
// pasted text box. Every writer of such a stored width and height measures here, such as the label editor's commit, a
// font or size change and a paste, so the renderer, which never measures, draws what was stored. It needs the DOM, so
// it lives in ui and never in lib.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { Textual, VectorElement, VectorElementPatch } from '@workspace/lib/vector';
import { getLineHeightPx } from '@workspace/lib/vector';

type TextDimensions = { width: number; height: number };

// The font a text is measured in. An arrow label has no weight and no letter spacing: its SVG <text> writes neither,
// so it draws at weight 400 with none. A text box's body writes both.
export type VectorTextFont = Pick<Textual, 'fontSize' | 'fontFamily'> &
    Partial<Pick<Textual, 'fontWeight' | 'letterSpacing'>>;

// Measures a text again once the slices of its font have loaded, and writes the fields `patch` makes of the new size
// to the live element. `patch` returns null when that element no longer holds what was measured.
export type HealTextSize = (
    id: string,
    text: string,
    font: VectorTextFont,
    patch: (el: VectorElement, size: TextDimensions) => VectorElementPatch | null,
) => void;

// One offscreen context, made on first use so that importing this module needs no DOM.
let context: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D {
    if (!context) {
        context = document.createElement('canvas').getContext('2d');
        if (!context) throw new Error('2d canvas context unavailable');
    }
    return context;
}

// The canvas font that matches the rendered text: its weight, its size and the family stack getFontFamily writes.
// measureText's advance width in this font is the width the text lays out at.
function vectorFontString({ fontSize, fontFamily, fontWeight = 'normal' }: VectorTextFont): string {
    return `${fontWeight} ${fontSize}px ${getFontFamily(fontFamily)}`;
}

// measureText measures a character in the fallback font until the face that draws it has loaded, so
// callers load the font before they measure. A face is cut into unicode-range slices, and the font
// set loads and checks only the slices of the text it is given. Without text it tests a space, so
// callers pass the text they will measure.
export function isVectorFontLoaded(text: string, font: VectorTextFont): boolean {
    return document.fonts.check(vectorFontString(font), text);
}

export async function loadVectorFont(text: string, font: VectorTextFont): Promise<void> {
    await document.fonts.load(vectorFontString(font), text);
}

// The width is the widest line's advance width, and the height is the line count times the line
// height. Lines split as the renderer splits them. The editor's scrollWidth is no substitute: it is
// rounded to whole pixels and includes padding. CSS adds the letter spacing after every character, the last one too.
export function measureVectorText(text: string, font: VectorTextFont): TextDimensions {
    const ctx = measureContext();
    ctx.font = vectorFontString(font);
    const spacing = font.letterSpacing ?? 0;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let width = 0;
    for (const line of lines) width = Math.max(width, ctx.measureText(line).width + spacing * [...line].length);
    return { width, height: lines.length * getLineHeightPx(font.fontFamily, font.fontSize) };
}

// The measure once the slices of the text have loaded, so it is the face's and never the fallback's. A writer that
// can wait, such as a font change, stores only this one. A writer that must store a size at once, such as a paste,
// stores measureVectorText's and heals it with this one.
export async function measureLoadedVectorText(text: string, font: VectorTextFont): Promise<TextDimensions> {
    await loadVectorFont(text, font);
    return measureVectorText(text, font);
}
