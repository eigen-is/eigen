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
