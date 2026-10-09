import { bundledFont, EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { type XmlElement, xmlChild } from '../../core/xml';
import { A_NS, BODY } from '../../export/doc/ooxml';
import { descendants } from './package';

// Which bundled font, if any, a Word font draws in: Eigen's by name, a foreign one by its category, an unknown one none.

export const MONOSPACE_FONT = EIGEN_FONTS.find((font) => font.category === 'monospace')?.name;

export type Theme = { font(themeName: string): string | undefined };

export function readTheme(root: XmlElement | undefined): Theme {
    const [scheme] = root ? descendants(root, A_NS, 'fontScheme') : [];
    const latin = (local: string) => {
        const font = scheme && xmlChild(scheme, A_NS, local);
        return (font && xmlChild(font, A_NS, 'latin')?.attributes['typeface']) || undefined;
    };
    const major = latin('majorFont');
    const minor = latin('minorFont');
    return { font: (name) => (name.startsWith('major') ? major : name.startsWith('minor') ? minor : undefined) };
}

export function isMonospace(name: string | undefined): boolean {
    return !!name && !!MONOSPACE_FONT && bundledFont(name) === MONOSPACE_FONT;
}

// The document font draws without a mark, so a foreign sans body is no mark and a serif or mono one is one per run.
export function fontMark(name: string | undefined): string | undefined {
    const font = name ? bundledFont(name) : undefined;
    return font === BODY.font ? undefined : font;
}
