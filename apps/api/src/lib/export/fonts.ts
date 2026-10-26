// The bundled fonts as @font-face rules, each WOFF2 face base64'd into a data: URI, for the HTML and PDF exports and
// the SVG previews, which have no app to fetch a font from. Also whether a face draws its own small caps.

import * as fs from 'node:fs';
import type { BundledFontFace, FontFaceFile } from '@workspace/lib/constants/fonts';
import { FONT_FACES, fontFaceCss, fontFacesOf } from '@workspace/lib/constants/fonts';
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

let allFacesCss: string | undefined;

export function allFontFaceCss(): string {
    return (allFacesCss ??= FONT_FACES.map(embeddedFaceCss).join('\n'));
}

// The @font-face blocks for just the given families (each an EIGEN_FONTS name, the same
// value a vector text/label element stores in `fontFamily`). An export or an SVG preview inlines
// only the whole faces its text actually uses; an unrecognized family contributes nothing.
export function getFontFaceCSSForFamilies(families: Iterable<string>): string {
    return fontFacesOf(families).map(embeddedFaceCss).join('\n');
}

// Read + base64 once per bundled font (~2 MB resident): the main-thread SVG preview path
// asks for faces on every request, while a one-shot export's child process pays it once anyway.
// A bundled asset that cannot be read is a build defect, so the read is unguarded.
const faceCSSByFile = new Map<FontFaceFile, string>();

function embeddedFaceCss(face: BundledFontFace): string {
    let css = faceCSSByFile.get(face.file);
    if (css === undefined) {
        const bytes = fs.readFileSync(FACE_PATHS[face.file]);
        css = fontFaceCss(face, `data:font/woff2;base64,${bytes.toString('base64')}`);
        faceCSSByFile.set(face.file, css);
    }
    return css;
}
