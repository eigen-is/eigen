// Client-side text measurement for vector text elements — DOM-coupled (canvas measureText),
// so it lives in packages/ui, never lib (the pure renderer trusts these stored dims and never
// measures). This is THE ONLY writer of a text element's width/height anywhere: the overlay
// commit, the resize commit, and unit F's font/size changes all route through it, so a single
// source produces dims the SVG <text> reproduces exactly.

import { getFontFamily } from '@workspace/lib/constants/fonts';
import { getLineHeightPx } from '@workspace/lib/vector';

export type TextDimensions = { width: number; height: number };

// One reused offscreen context — created lazily so module-eval stays DOM-free (BE-safe import
// graph, though this module is only ever pulled in by client components).
let ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
    if (!ctx) {
        const c = document.createElement('canvas').getContext('2d');
        if (!c) throw new Error('2d canvas context unavailable');
        ctx = c;
    }
    return ctx;
}

// The canvas font shorthand that reproduces the SVG <text> output: weight 400 (the renderer
// emits no font-weight, so the browser uses normal/400), px size, and the same family+fallback
// chain getFontFamily emits. measureText advance width at this string is exactly what SVG
// <text> lays out (Excalidraw's default CanvasTextMetricsProvider).
export function vectorFontString(fontSize: number, fontFamily: string): string {
    return `400 ${fontSize}px ${getFontFamily(fontFamily)}`;
}

// measureText returns fallback-font garbage until the face is registered in document.fonts, so
// callers ensure the font is loaded first. The overlay awaits loadVectorFont on open; by commit
// the check passes.
export function isVectorFontLoaded(fontSize: number, fontFamily: string): boolean {
    return document.fonts.check(vectorFontString(fontSize, fontFamily));
}

export async function loadVectorFont(fontSize: number, fontFamily: string): Promise<void> {
    await document.fonts.load(vectorFontString(fontSize, fontFamily));
}

// width = the widest line's advance width; height = lineCount × the lib metrics-table line
// height. Split matches the renderer's (/\r\n?/g → \n). Never the textarea's scrollWidth/
// scrollHeight — those are integer-rounded, padding-contaminated, and not what <text> lays out.
export function measureVectorText(text: string, fontSize: number, fontFamily: string): TextDimensions {
    const c = measureCtx();
    c.font = vectorFontString(fontSize, fontFamily);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let width = 0;
    for (const line of lines) {
        const w = c.measureText(line).width;
        if (w > width) width = w;
    }
    return { width, height: lines.length * getLineHeightPx(fontFamily, fontSize) };
}
