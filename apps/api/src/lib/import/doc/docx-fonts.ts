import { bundledFont, EIGEN_FONTS, type EigenFont } from '@workspace/lib/constants/fonts';
import { A_NS, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlChild, xmlElements } from '../../core/xml';
import { BODY } from '../../export/doc/looks';
import { descendants, is, w, wChild } from './package';

// Which bundled font, if any, a Word font draws in: Eigen's by name, a foreign one by its category, an unknown one none.

export const MONOSPACE_FONT = EIGEN_FONTS.find((font) => font.category === 'monospace')?.name;

export type Theme = { font(themeName: string, bidiLanguage?: string): string | undefined };

// *Bidi names the complex script face: the theme's a:cs, else its a:font for the script of the run's bidi language,
// which the document's default language answers when the run names none.
export function readTheme(root: XmlElement | undefined, defaultBidiLanguage?: string): Theme {
    const [scheme] = root ? descendants(root, A_NS, 'fontScheme') : [];
    const typeface = (font: XmlElement | undefined) => font?.attributes['typeface'] || undefined;
    const faces = (local: string) => {
        const collection = scheme && xmlChild(scheme, A_NS, local);
        if (!collection) return undefined;
        const byScript = new Map(
            xmlElements(collection)
                .filter((font) => is(font, A_NS, 'font'))
                .map((font) => [font.attributes['script'] ?? '', typeface(font)]),
        );
        return {
            latin: typeface(xmlChild(collection, A_NS, 'latin')),
            bidi: (language: string | undefined) =>
                typeface(xmlChild(collection, A_NS, 'cs')) ?? byScript.get(scriptOf(language) ?? ''),
        };
    };
    const major = faces('majorFont');
    const minor = faces('minorFont');
    // Per language: a script lookup costs microseconds, and a file may name a language on every run.
    const bidi = new Map<string, string | undefined>();
    return {
        font: (name, bidiLanguage = defaultBidiLanguage) => {
            const collection = name.startsWith('major') ? major : name.startsWith('minor') ? minor : undefined;
            if (!name.endsWith('Bidi')) return collection?.latin;
            const key = `${name} ${bidiLanguage}`;
            if (!bidi.has(key)) bidi.set(key, collection?.bidi(bidiLanguage));
            return bidi.get(key);
        },
    };
}

// The ISO 15924 code the theme's a:font names, from a BCP 47 tag; a malformed tag from the file has none.
function scriptOf(language: string | undefined): string | undefined {
    if (!language) return undefined;
    try {
        return new Intl.Locale(language).maximize().script;
    } catch {
        return undefined;
    }
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
