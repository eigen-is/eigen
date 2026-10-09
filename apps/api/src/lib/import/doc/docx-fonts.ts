import { bundledFont, EIGEN_FONTS, type EigenFont } from '@workspace/lib/constants/fonts';
import { type XmlElement, xmlChild, xmlElements } from '../../core/xml';
import { A_NS, BODY, W_NS } from '../../export/doc/ooxml';
import { descendants, is, w, wChild } from './package';

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

// A name the map doesn't know, onto the bundled font of its fontTable.xml category, lowercase as the map's.
export type FontTable = Map<string, string>;

// Word writes roman with pitch default for a font it has no metrics of (ArialMT, MinionPro-Regular), and modern for
// some variable sans, so a family counts only beside a known variable pitch. P4: script, decorative and auto are unknown.
const FAMILY_CATEGORIES = new Map<string, EigenFont['category']>([
    ['roman', 'serif'],
    ['swiss', 'sans-serif'],
]);

export function readFontTable(root: XmlElement | undefined): FontTable {
    const table: FontTable = new Map();
    for (const font of root ? xmlElements(root) : []) {
        const name = w(font, 'name');
        if (!is(font, W_NS, 'font') || !name) continue;
        const pitch = w(wChild(font, 'pitch'), 'val');
        const family = w(wChild(font, 'family'), 'val') ?? '';
        const category =
            pitch === 'fixed' ? 'monospace' : pitch === 'variable' ? FAMILY_CATEGORIES.get(family) : undefined;
        const bundled = category && EIGEN_FONTS.find((eigen) => eigen.category === category)?.name;
        if (bundled) table.set(name.trim().toLowerCase(), bundled);
    }
    return table;
}

function bundledFontOf(name: string | undefined, fontTable?: FontTable): string | undefined {
    return name ? (bundledFont(name) ?? fontTable?.get(name.trim().toLowerCase())) : undefined;
}

export function isMonospace(name: string | undefined, fontTable?: FontTable): boolean {
    return !!MONOSPACE_FONT && bundledFontOf(name, fontTable) === MONOSPACE_FONT;
}

// The document font draws without a mark, so a foreign sans body is no mark and a serif or mono one is one per run.
export function fontMark(name: string | undefined, fontTable?: FontTable): string | undefined {
    const font = bundledFontOf(name, fontTable);
    return font === BODY.font ? undefined : font;
}
