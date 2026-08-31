import * as fs from 'node:fs';
import fontExcalifont from '@workspace/ui/assets/fonts/excalifont/Excalifont-Regular.woff2' with { type: 'file' };
import fontInterRegular from '@workspace/ui/assets/fonts/inter/Inter-Variable.woff2' with { type: 'file' };
import fontInterItalic from '@workspace/ui/assets/fonts/inter/Inter-Variable-Italic.woff2' with { type: 'file' };
import fontMonoRegular from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2' with {
    type: 'file',
};
import fontSerifRegular from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Variable.woff2' with {
    type: 'file',
};
import fontSerifItalic from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Variable-Italic.woff2' with {
    type: 'file',
};

const FONT_FILES = [
    { family: 'Inter', path: fontInterRegular, weight: '100 900', style: 'normal' },
    { family: 'Inter', path: fontInterItalic, weight: '100 900', style: 'italic' },
    { family: 'Source Serif 4', path: fontSerifRegular, weight: '200 900', style: 'normal' },
    { family: 'Source Serif 4', path: fontSerifItalic, weight: '200 900', style: 'italic' },
    { family: 'JetBrains Mono', path: fontMonoRegular, weight: '100 800', style: 'normal' },
    { family: 'Excalifont', path: fontExcalifont, weight: '400', style: 'normal' },
] as const;

let _fontCSS: string | undefined;

export function getFontCSS(): string {
    return (_fontCSS ??= buildFontFaceCSS(FONT_FILES));
}

// The @font-face blocks for just the given families (each an EIGEN_FONTS name, the same
// value a vector text/label element stores in `fontFamily`). The SVG export inlines only
// the whole faces its text actually uses; an unrecognized family contributes nothing.
export function getFontFaceCSSForFamilies(families: Iterable<string>): string {
    const wanted = new Set(families);
    return buildFontFaceCSS(FONT_FILES.filter((font) => wanted.has(font.family)));
}

function buildFontFaceCSS(fonts: readonly (typeof FONT_FILES)[number][]): string {
    return fonts
        .map((font) => {
            try {
                const buf = fs.readFileSync(font.path);
                const dataUri = `data:font/woff2;base64,${buf.toString('base64')}`;
                return `@font-face {
    font-family: "${font.family}";
    src: url("${dataUri}") format("woff2");
    font-weight: ${font.weight};
    font-style: ${font.style};
    font-display: swap;
}`;
            } catch {
                console.warn(`[export/fonts] Failed to read font: ${font.path}`);
                return '';
            }
        })
        .filter(Boolean)
        .join('\n');
}
