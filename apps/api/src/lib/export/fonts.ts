import * as fs from 'node:fs';
import type { EigenFont } from '@workspace/lib/constants/fonts';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import docxExcalifontRegular from '@workspace/ui/assets/fonts/excalifont/Excalifont-Regular.ttf' with { type: 'file' };
import fontExcalifont from '@workspace/ui/assets/fonts/excalifont/Excalifont-Regular.woff2' with { type: 'file' };
import docxInterBold from '@workspace/ui/assets/fonts/inter/Inter-Bold-renamed.ttf' with { type: 'file' };
import docxInterBoldItalic from '@workspace/ui/assets/fonts/inter/Inter-BoldItalic-renamed.ttf' with { type: 'file' };
import docxInterItalic from '@workspace/ui/assets/fonts/inter/Inter-Italic.ttf' with { type: 'file' };
import docxInterRegular from '@workspace/ui/assets/fonts/inter/Inter-Regular.ttf' with { type: 'file' };
import fontInterRegular from '@workspace/ui/assets/fonts/inter/Inter-Variable.woff2' with { type: 'file' };
import fontInterItalic from '@workspace/ui/assets/fonts/inter/Inter-Variable-Italic.woff2' with { type: 'file' };
import docxMonoBold from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Bold-renamed.ttf' with {
    type: 'file',
};
import docxMonoBoldItalic from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic-renamed.ttf' with {
    type: 'file',
};
import docxMonoItalic from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Italic.ttf' with { type: 'file' };
import docxMonoRegular from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf' with { type: 'file' };
import fontMonoRegular from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2' with {
    type: 'file',
};
import docxSerifBold from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Bold.ttf' with { type: 'file' };
import docxSerifBoldItalic from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-BoldIt.ttf' with { type: 'file' };
import docxSerifItalic from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-It.ttf' with { type: 'file' };
import docxSerifRegular from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Regular.ttf' with { type: 'file' };
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

export type DocxFontFiles = { Regular: string; Italic?: string; Bold?: string; BoldItalic?: string };

// Inter's and JetBrains Mono's Bold slots hold their 600s renamed Bold, the weight the editor draws bold in.
const DOCX_FONT_FILES_BY_CATEGORY: Record<EigenFont['category'], DocxFontFiles> = {
    'sans-serif': {
        Regular: docxInterRegular,
        Italic: docxInterItalic,
        Bold: docxInterBold,
        BoldItalic: docxInterBoldItalic,
    },
    serif: { Regular: docxSerifRegular, Italic: docxSerifItalic, Bold: docxSerifBold, BoldItalic: docxSerifBoldItalic },
    monospace: { Regular: docxMonoRegular, Italic: docxMonoItalic, Bold: docxMonoBold, BoldItalic: docxMonoBoldItalic },
    'hand-drawn': { Regular: docxExcalifontRegular },
};

// The static faces a docx embeds per EIGEN_FONTS name; Word synthesizes a slot a family has no file for.
export const DOCX_FONT_FILES: ReadonlyMap<string, DocxFontFiles> = new Map(
    EIGEN_FONTS.map((font) => [font.name, DOCX_FONT_FILES_BY_CATEGORY[font.category]]),
);

// A bounded read of the sfnt table directory: a table past the end of the file throws instead of reading short.
export function sfntTables(bytes: Buffer): Map<string, Buffer> {
    const tables = new Map<string, Buffer>();
    for (let i = 0; i < bytes.readUInt16BE(4); i++) {
        const record = 12 + i * 16;
        const offset = bytes.readUInt32BE(record + 8);
        const end = offset + bytes.readUInt32BE(record + 12);
        if (end > bytes.length) throw new Error(`table ${i} ends past the file`);
        tables.set(bytes.toString('latin1', record, record + 4), bytes.subarray(offset, end));
    }
    return tables;
}

let _fontCSS: string | undefined;

export function getFontCSS(): string {
    return (_fontCSS ??= FONT_FILES.map(fontFaceCSS).join('\n'));
}

// The @font-face blocks for just the given families (each an EIGEN_FONTS name, the same
// value a vector text/label element stores in `fontFamily`). The SVG export inlines only
// the whole faces its text actually uses; an unrecognized family contributes nothing.
export function getFontFaceCSSForFamilies(families: Iterable<string>): string {
    const wanted = new Set(families);
    return FONT_FILES.filter((font) => wanted.has(font.family))
        .map(fontFaceCSS)
        .join('\n');
}

// Read + base64 once per bundled font (~2 MB resident): the main-thread SVG preview path
// asks for faces on every request, while a one-shot export Worker pays it once anyway.
// A bundled asset that cannot be read is a build defect, so the read is unguarded.
const faceCSSByFont = new Map<(typeof FONT_FILES)[number], string>();

function fontFaceCSS(font: (typeof FONT_FILES)[number]): string {
    let css = faceCSSByFont.get(font);
    if (css === undefined) {
        const dataUri = `data:font/woff2;base64,${fs.readFileSync(font.path).toString('base64')}`;
        css = `@font-face {
    font-family: "${font.family}";
    src: url("${dataUri}") format("woff2");
    font-weight: ${font.weight};
    font-style: ${font.style};
    font-display: swap;
}`;
        faceCSSByFont.set(font, css);
    }
    return css;
}
