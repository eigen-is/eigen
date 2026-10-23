import { pxToPt } from '../docs/eigendoc/page';

// lineHeight: its single line as a multiple of its size, (usWinAscent + usWinDescent) / unitsPerEm of its Regular, as Word
// and Google Docs draw it; the API's fonts.test.ts pins each against the TTF.
export type EigenFont = {
    name: string;
    family: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'hand-drawn';
    weights: number[];
    lineHeight: number;
};

// Order is load-bearing: numeric xlsx font indices (ff) index into this array, [0] is the
// default in docs and sheets (the canvas has its own, DEFAULT_FONT_FAMILY), and a category's
// first font is the one a foreign font of that category maps to.
export const EIGEN_FONTS: EigenFont[] = [
    {
        name: 'Inter',
        family: "'Inter', sans-serif",
        category: 'sans-serif',
        weights: [400, 500, 600, 700],
        lineHeight: 1.21,
    },
    {
        name: 'Source Serif 4',
        family: "'Source Serif 4', serif",
        category: 'serif',
        weights: [400, 600, 700],
        lineHeight: 1.371,
    },
    {
        name: 'JetBrains Mono',
        family: "'JetBrains Mono', monospace",
        category: 'monospace',
        weights: [400, 700],
        lineHeight: 1.32,
    },
    { name: 'Excalifont', family: "'Excalifont', cursive", category: 'hand-drawn', weights: [400], lineHeight: 1.26 },
];

// A doc's text draws in it without a font mark, so a paste or an import gives it none.
export const DOCUMENT_FONT = EIGEN_FONTS[0].name;

// A family's single line; one no font of Eigen's names draws in the document's.
export function fontLineHeight(name: string): number {
    return (EIGEN_FONTS.find((font) => font.name === name) ?? EIGEN_FONTS[0]).lineHeight;
}

// A paragraph's CSS line-height is its line spacing times the document font's single line, as CSS can't know the fonts
// of a paragraph's runs.
export const DOCUMENT_LINE_RATIO = fontLineHeight(DOCUMENT_FONT);

// A doc's text draws at it without a size mark: eigen-prose.css's body, in pt.
export const DOCUMENT_FONT_SIZE = 11;

// Small's: eigen-prose.css's small, in pt.
export const SMALL_FONT_SIZE = 9;

// A footnote's text, at Google's and Word's footnote size, in pt: the editor's notes (the Docs app's globals.css), the
// exports' and the docx's Footnote Text.
export const FOOTNOTE_FONT_SIZE = 10;

// Google Docs' and Sheets' font sizes, in pt, both of which step by 1.
export const MIN_FONT_SIZE = 1;
export const MAX_FONT_SIZE = 400;

// Any peer, paste or file writes a size, so only a finite number is one; it lands in the range, in Word's half points.
export function readFontSize(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value * 2) / 2));
}

// pt and px are a size; em, rem, % and keywords are relative to what the source drew around them.
const ABSOLUTE_SIZE = /^(\d*\.?\d+)(pt|px)$/;

// A CSS font-size as a size in pt: pt as it is, px at CSS's 96 dpi.
export function readCssFontSize(css: string): number | undefined {
    const match = ABSOLUTE_SIZE.exec(css.trim());
    if (!match) return undefined;
    const size = Number(match[1]);
    return readFontSize(match[2] === 'px' ? pxToPt(size) : size);
}

export function nextFontSize(size: number, by: 1 | -1): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size + by));
}

// The vocabulary a stored `fontFamily` must be one of — a name, never a CSS stack. Readers validate
// against this so an unrecognised value falls back instead of reaching a CSS declaration.
export const EIGEN_FONT_NAMES: readonly string[] = EIGEN_FONTS.map((f) => f.name);

export function getFontFamily(fontName: string): string {
    const font = EIGEN_FONTS.find((f) => f.name === fontName);
    return font?.family ?? `'${fontName}', sans-serif`;
}

// Tolerant forward map for render seams (the docs textStyle `fontFamily` mark). An EIGEN_FONTS
// name expands to its CSS stack; a value that is already a stack — or any unknown token — passes
// through unchanged, so pre-canon docs (fontFamily stored as a full stack) render byte-identically
// until the load-time normalizer collapses them. Unlike getFontFamily, this must NOT wrap an
// unrecognized value, or a stored stack would be double-wrapped.
export function fontNameToCss(value: string): string {
    return EIGEN_FONTS.find((f) => f.name === value)?.family ?? value;
}

// Reverse lookup for write seams (docs paste/import parseHTML + the load-time normalizer): a
// recognized EIGEN font given as its name OR its full CSS stack (any quote style) collapses to the
// canonical EIGEN_FONTS name; any other value is returned unchanged, so fontNameToCss's
// passthrough keeps it lossless. No second font list — it reads EIGEN_FONTS.
export function getFontName(value: string): string {
    const first = value.match(/^\s*['"]?([^'",]+)['"]?/)?.[1]?.trim();
    const match = first ? EIGEN_FONTS.find((f) => f.name === first) : undefined;
    return match ? match.name : value;
}

// Font names, trimmed and lowercase, onto the category whose bundled font stands in for them: only the
// bundled faces are embedded in an export.
const FONT_CATEGORY_MAP: ReadonlyMap<string, EigenFont['category']> = new Map([
    ...EIGEN_FONTS.map((font): [string, EigenFont['category']] => [font.name.toLowerCase(), font.category]),
    ['calibri', 'sans-serif'],
    ['calibri light', 'sans-serif'],
    ['aptos', 'sans-serif'],
    ['arial', 'sans-serif'],
    ['arimo', 'sans-serif'],
    ['helvetica', 'sans-serif'],
    ['helvetica neue', 'sans-serif'],
    ['lato', 'sans-serif'],
    ['liberation sans', 'sans-serif'],
    ['montserrat', 'sans-serif'],
    ['noto sans', 'sans-serif'],
    ['open sans', 'sans-serif'],
    ['oswald', 'sans-serif'],
    ['quicksand', 'sans-serif'],
    ['roboto', 'sans-serif'],
    ['segoe ui', 'sans-serif'],
    ['tahoma', 'sans-serif'],
    ['trebuchet ms', 'sans-serif'],
    ['verdana', 'sans-serif'],
    ['source serif pro', 'serif'],
    ['book antiqua', 'serif'],
    ['cambria', 'serif'],
    ['garamond', 'serif'],
    ['georgia', 'serif'],
    ['liberation serif', 'serif'],
    ['lora', 'serif'],
    ['merriweather', 'serif'],
    ['noto serif', 'serif'],
    ['palatino', 'serif'],
    ['palatino linotype', 'serif'],
    ['times', 'serif'],
    ['times new roman', 'serif'],
    ['tinos', 'serif'],
    ['consolas', 'monospace'],
    ['courier', 'monospace'],
    ['courier new', 'monospace'],
    ['cousine', 'monospace'],
    ['fira code', 'monospace'],
    ['liberation mono', 'monospace'],
    ['lucida console', 'monospace'],
    ['menlo', 'monospace'],
    ['monaco', 'monospace'],
    ['roboto mono', 'monospace'],
    ['source code pro', 'monospace'],
    ['comic sans', 'hand-drawn'],
    ['comic sans ms', 'hand-drawn'],
]);

export function bundledFontOfCategory(category: EigenFont['category']): string | undefined {
    return EIGEN_FONTS.find((font) => font.category === category)?.name;
}

export function bundledFont(name: string): string | undefined {
    const category = FONT_CATEGORY_MAP.get(name.trim().toLowerCase());
    return category && bundledFontOfCategory(category);
}

// A CSS stack's first family the map knows: Google Docs and Word write a font before its generic family.
export function bundledFontOfStack(stack: string): string | undefined {
    return stack
        .split(',')
        .map((family) => bundledFont(family.replace(/['"]/g, '')))
        .find((bundled) => bundled !== undefined);
}
