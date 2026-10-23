import * as fs from 'node:fs';
import {
    type BundledFontFace,
    FONT_FACES,
    type FontFaceFile,
    fontFaceCss,
    fontFacesOf,
} from '@workspace/lib/constants/fonts';
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

// The bundler's path of each registry face (its asset in the build), keyed by the file FONT_FACES names: the record
// type makes it list every face and nothing else, so the faces themselves are only ever the registry's.
const FACE_PATHS: Record<FontFaceFile, string> = {
    'inter/Inter-Variable.woff2': fontInterRegular,
    'inter/Inter-Variable-Italic.woff2': fontInterItalic,
    'source-serif/SourceSerif4-Variable.woff2': fontSerifRegular,
    'source-serif/SourceSerif4-Variable-Italic.woff2': fontSerifItalic,
    'jetbrains-mono/JetBrainsMono-Variable.woff2': fontMonoRegular,
    'excalifont/Excalifont-Regular.woff2': fontExcalifont,
};

export function hasSmallCaps(family: string, style: BundledFontFace['style']): boolean {
    return FONT_FACES.some((face) => face.family === family && face.style === style && 'smallCaps' in face);
}

export type DocxFontFiles = { Regular: string; Italic?: string; Bold?: string; BoldItalic?: string };

// The static faces a docx embeds per EIGEN_FONTS name, in its order; Word synthesizes a slot a family has no file for.
// Inter's and JetBrains Mono's Bold slots hold their 600s renamed Bold, the weight the editor draws bold in.
export const DOCX_FONT_FILES: ReadonlyMap<string, DocxFontFiles> = new Map([
    [
        'Inter',
        { Regular: docxInterRegular, Italic: docxInterItalic, Bold: docxInterBold, BoldItalic: docxInterBoldItalic },
    ],
    [
        'Source Serif 4',
        { Regular: docxSerifRegular, Italic: docxSerifItalic, Bold: docxSerifBold, BoldItalic: docxSerifBoldItalic },
    ],
    [
        'JetBrains Mono',
        { Regular: docxMonoRegular, Italic: docxMonoItalic, Bold: docxMonoBold, BoldItalic: docxMonoBoldItalic },
    ],
    ['Excalifont', { Regular: docxExcalifontRegular }],
]);

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
    return (_fontCSS ??= FONT_FACES.map(fontFaceCSS).join('\n'));
}

// The @font-face blocks for just the given families (each an EIGEN_FONTS name, the same
// value a vector text/label element stores in `fontFamily`). An export or an SVG preview inlines
// only the whole faces its text actually uses; an unrecognized family contributes nothing.
export function getFontFaceCSSForFamilies(families: Iterable<string>): string {
    return fontFacesOf(families).map(fontFaceCSS).join('\n');
}

// Read + base64 once per bundled font (~2 MB resident): the main-thread SVG preview path
// asks for faces on every request, while a one-shot export Worker pays it once anyway.
// A bundled asset that cannot be read is a build defect, so the read is unguarded.
const faceCSSByFile = new Map<FontFaceFile, string>();

function fontFaceCSS(face: BundledFontFace): string {
    let css = faceCSSByFile.get(face.file);
    if (css === undefined) {
        const bytes = fs.readFileSync(FACE_PATHS[face.file]);
        css = fontFaceCss(face, `data:font/woff2;base64,${bytes.toString('base64')}`);
        faceCSSByFile.set(face.file, css);
    }
    return css;
}
