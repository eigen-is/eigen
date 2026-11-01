// Measures the plain text of a vector element, such as an arrow label, on a canvas in the font the
// SVG <text> draws it in. Every writer of that text's stored width and height measures here, such as
// the label editor's commit, a font or size change and a paste, so the renderer, which never
// measures, draws what was stored. It needs the DOM, so it lives in ui and never in lib.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { getLineHeightPx } from '@workspace/lib/vector';

type TextDimensions = { width: number; height: number };

// One offscreen context, made on first use so that importing this module needs no DOM.
let context: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D {
    if (!context) {
        context = document.createElement('canvas').getContext('2d');
        if (!context) throw new Error('2d canvas context unavailable');
    }
    return context;
}

// The canvas font that matches the SVG <text>: weight 400, because the renderer writes no weight,
// and the same family stack getFontFamily writes. measureText's advance width in this font is the
// width SVG <text> lays out.
function vectorFontString(fontSize: number, fontFamily: string): string {
    return `400 ${fontSize}px ${getFontFamily(fontFamily)}`;
}

// measureText measures a character in the fallback font until the face that draws it has loaded, so
// callers load the font before they measure. A face is cut into unicode-range slices, and the font
// set loads and checks only the slices of the text it is given. Without text it tests a space, so
// callers pass the text they will measure.
export function isVectorFontLoaded(fontSize: number, fontFamily: string, text: string): boolean {
    return document.fonts.check(vectorFontString(fontSize, fontFamily), text);
}

export async function loadVectorFont(fontSize: number, fontFamily: string, text: string): Promise<void> {
    await document.fonts.load(vectorFontString(fontSize, fontFamily), text);
}

// The width is the widest line's advance width, and the height is the line count times the line
// height. Lines split as the renderer splits them. The editor's scrollWidth is no substitute: it is
// rounded to whole pixels and includes padding.
export function measureVectorText(text: string, fontSize: number, fontFamily: string): TextDimensions {
    const ctx = measureContext();
    ctx.font = vectorFontString(fontSize, fontFamily);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let width = 0;
    for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
    return { width, height: lines.length * getLineHeightPx(fontFamily, fontSize) };
}
