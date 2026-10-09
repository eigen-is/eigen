export type EigenFont = {
    name: string;
    family: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'hand-drawn';
    weights: number[];
};

// Order is load-bearing: numeric xlsx font indices (ff) index into this array, [0] is the
// default in docs and sheets (the canvas has its own, DEFAULT_FONT_FAMILY), and each category
// maps to exactly one bundled font.
export const EIGEN_FONTS: EigenFont[] = [
    { name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif', weights: [400, 500, 600, 700] },
    { name: 'Source Serif 4', family: "'Source Serif 4', serif", category: 'serif', weights: [400, 600, 700] },
    { name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", category: 'monospace', weights: [400, 700] },
    { name: 'Excalifont', family: "'Excalifont', cursive", category: 'hand-drawn', weights: [400] },
];

// A doc's text draws in it without a font mark, so a paste or an import gives it none.
export const DOCUMENT_FONT = EIGEN_FONTS[0].name;

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
// bundled faces are embedded in an export. Read by xlsx and docx import and by the docs paste.
export const FONT_CATEGORY_MAP: ReadonlyMap<string, EigenFont['category']> = new Map<string, EigenFont['category']>([
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

export function bundledFont(name: string): string | undefined {
    const category = FONT_CATEGORY_MAP.get(name.trim().toLowerCase());
    return category && EIGEN_FONTS.find((font) => font.category === category)?.name;
}
