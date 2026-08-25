export type EigenFont = {
    name: string;
    family: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'hand-drawn';
    weights: number[];
};

// Order is load-bearing: numeric xlsx font indices (ff) index into this array, [0] is the
// document default everywhere, and each category maps to exactly one bundled font.
export const EIGEN_FONTS: EigenFont[] = [
    { name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif', weights: [400, 500, 600, 700] },
    { name: 'Source Serif 4', family: "'Source Serif 4', serif", category: 'serif', weights: [400, 600, 700] },
    { name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", category: 'monospace', weights: [400, 700] },
    { name: 'Excalifont', family: "'Excalifont', cursive", category: 'hand-drawn', weights: [400] },
];

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
