// The fonts Eigen bundles, and how a stored font name becomes CSS. EIGEN_FONTS are the fonts a user picks, and
// FALLBACK_FONTS the faces that draw what those lack, such as emoji; getFontFamily joins them into every stack Eigen
// writes. The pickers, the readers of a stored font and the exports all read these lists. The font sizes a doc and a
// sheet accept, and the map from a foreign font such as Calibri to a bundled one, live here too.

import { pxToPt } from '../docs/eigendoc/page';

// lineHeight is the font's single line as a multiple of its size, as Word and Google Docs draw it. It is
// (usWinAscent + usWinDescent) / unitsPerEm of its Regular, and a test checks each against the TTF.
export type EigenFont = {
    name: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'hand-drawn';
    lineHeight: number;
};

// A font no one picks: it draws what the text faces lack. An emoji or CJK face covers the characters of its kind; the
// math face draws only a formula.
export type FallbackFont = {
    family: string;
    kind: 'emoji' | 'cjk' | 'math';
};

// Order is load-bearing: the vendoring script gives a character to the first of these whose kind covers it, before
// any text face, so no two families draw the same character.
export const FALLBACK_FONTS: readonly FallbackFont[] = [
    { family: 'Eigen Emoji', kind: 'emoji' },
    { family: 'Noto Sans SC', kind: 'cjk' },
    { family: 'Noto Sans KR', kind: 'cjk' },
    { family: 'New Computer Modern Math', kind: 'math' },
];

// Any text may draw in the emoji and CJK faces, so every text stack and every export names them. Only a formula draws
// in the math face, so only a document with one embeds it.
export const TEXT_FALLBACK_FAMILIES: readonly string[] = FALLBACK_FONTS.filter((font) => font.kind !== 'math').map(
    (font) => font.family,
);
export const EMOJI_FAMILIES: readonly string[] = FALLBACK_FONTS.filter((font) => font.kind === 'emoji').map(
    (font) => font.family,
);
export const MATH_FAMILIES: readonly string[] = FALLBACK_FONTS.filter((font) => font.kind === 'math').map(
    (font) => font.family,
);

// What each category falls back to after Eigen's own faces: the system's faces of that kind, then the generic family.
const SYSTEM_FALLBACKS: Record<EigenFont['category'], string> = {
    'sans-serif': 'ui-sans-serif, system-ui, sans-serif',
    serif: "Georgia, 'Times New Roman', serif",
    monospace: "'Fira Code', ui-monospace, monospace",
    'hand-drawn': "'Comic Sans MS', cursive",
};

// The stack of a <math>: the bundled math face, then the browser's own math font.
export const MATH_FONT_STACK = [...MATH_FAMILIES.map((family) => `'${family}'`), 'math'].join(', ');

// Order is load-bearing: a sheet cell's `ff` may be an index into this list, so a new font goes at the end. [0] is the
// default in docs and sheets; the canvas has its own.
export const EIGEN_FONTS: readonly EigenFont[] = [
    {
        name: 'Inter',
        category: 'sans-serif',
        lineHeight: 1.21,
    },
    {
        name: 'Source Serif 4',
        category: 'serif',
        lineHeight: 1.371,
    },
    {
        name: 'JetBrains Mono',
        category: 'monospace',
        lineHeight: 1.32,
    },
    {
        name: 'Excalifont',
        category: 'hand-drawn',
        lineHeight: 1.26,
    },
];

// A doc's text draws in it without a font mark, so a paste or an import gives it none.
export const DOCUMENT_FONT = EIGEN_FONTS[0].name;

// A family's single line. A family Eigen doesn't bundle draws in the document font, so it takes that font's line.
export function fontLineHeight(name: string): number {
    return (EIGEN_FONTS.find((font) => font.name === name) ?? EIGEN_FONTS[0]).lineHeight;
}

// The size a doc's text draws at without a size mark, as eigen-prose.css sets the body, in pt.
export const DOCUMENT_FONT_SIZE = 11;

// The size of the Small style, as eigen-prose.css sets it, in pt.
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
    return snapFontSize(value);
}

export function snapFontSize(size: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size * 2) / 2));
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

// The values a stored `fontFamily` may hold: a name, never a CSS stack. Readers check a stored value against these,
// so an unknown one falls back instead of reaching a CSS declaration.
export const EIGEN_FONT_NAMES: readonly string[] = EIGEN_FONTS.map((font) => font.name);

// A sheet cell may name a font Eigen doesn't bundle, so the stack of the bundled font it maps to follows the name. The
// emoji face holds the digits, # and * for its keycaps, so a stack without a text face before it would draw them there.
export function getFontFamily(fontName: string): string {
    const bundled = EIGEN_FONTS.find((font) => font.name === fontName);
    if (bundled) return fontStack(bundled);
    return `'${fontName}', ${getFontFamily(bundledFont(fontName) ?? DOCUMENT_FONT)}`;
}

// A name expands to its stack; any other value, such as a whole stack a doc stores, passes through. Unlike
// getFontFamily this must not wrap an unknown value, or a stored stack would be wrapped twice.
export function fontNameToCss(value: string): string {
    const bundled = EIGEN_FONTS.find((font) => font.name === value);
    return bundled ? fontStack(bundled) : value;
}

// The fallback faces' slices cover disjoint characters, so their order never decides which face draws a glyph.
function fontStack(font: EigenFont): string {
    const families = [font.name, ...TEXT_FALLBACK_FAMILIES].map((family) => `'${family}'`);
    return [...families, SYSTEM_FALLBACKS[font.category]].join(', ');
}

// The reverse, for a paste, an import and a mark that stores a stack. Any other value comes back unchanged, so
// fontNameToCss draws it as it was.
export function getFontName(value: string): string {
    const first = value.match(/^\s*['"]?([^'",]+)['"]?/)?.[1]?.trim();
    const match = first ? EIGEN_FONTS.find((font) => font.name === first) : undefined;
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

// smallCaps: the face has the OpenType smcp glyphs, the only small caps WeasyPrint draws.
type EigenFontFace = {
    family: string;
    file: string;
    weight: string;
    style: 'normal' | 'italic';
    smallCaps?: true;
};

// The woff2 faces of EIGEN_FONTS, each a file among the UI package's font assets, which the vendoring script cuts into
// the slices the apps load and the exports embed.
export const FONT_FACES = [
    { family: 'Inter', file: 'inter/Inter-Variable.woff2', weight: '100 900', style: 'normal' },
    { family: 'Inter', file: 'inter/Inter-Variable-Italic.woff2', weight: '100 900', style: 'italic' },
    {
        family: 'Source Serif 4',
        file: 'source-serif/SourceSerif4-Variable.woff2',
        weight: '200 900',
        style: 'normal',
        smallCaps: true,
    },
    {
        family: 'Source Serif 4',
        file: 'source-serif/SourceSerif4-Variable-Italic.woff2',
        weight: '200 900',
        style: 'italic',
    },
    {
        family: 'JetBrains Mono',
        file: 'jetbrains-mono/JetBrainsMono-Variable.woff2',
        weight: '100 800',
        style: 'normal',
    },
    { family: 'Excalifont', file: 'excalifont/Excalifont-Regular.woff2', weight: '400', style: 'normal' },
] as const satisfies readonly EigenFontFace[];

export type BundledFontFace = (typeof FONT_FACES)[number];
