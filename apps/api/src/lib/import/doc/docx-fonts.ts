import { bundledFont, DOCUMENT_FONT, EIGEN_FONTS, type EigenFont } from '@workspace/lib/constants/fonts';
import { codePoint as dingbat } from 'dingbat-to-unicode';
import { A_NS, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlChild, xmlElements } from '../../core/xml';
import { descendants, is, w, wChild } from './package';

// Which bundled font, if any, a Word font draws in: Eigen's by name, a foreign one by its category, an unknown one none.

export const MONOSPACE_FONT = EIGEN_FONTS.find((font) => font.category === 'monospace')?.name;

export type Theme = { font(themeName: string, language?: string): string | undefined };

// The languages a run's theme fonts answer by: w:lang's bidi for *Bidi, its eastAsia for *EastAsia.
export type Languages = { bidi?: string; eastAsia?: string };

// *Bidi names the complex script face: the theme's a:cs, else its a:font for the script of the run's bidi language,
// which the document's default language answers when the run names none; *EastAsia the a:ea face the same way.
export function readTheme(root: XmlElement | undefined, defaults: Languages): Theme {
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
        const scripted = (face: 'cs' | 'ea') => (language: string | undefined) =>
            typeface(xmlChild(collection, A_NS, face)) ?? byScript.get(scriptOf(language) ?? '');
        return { latin: typeface(xmlChild(collection, A_NS, 'latin')), bidi: scripted('cs'), eastAsia: scripted('ea') };
    };
    const major = faces('majorFont');
    const minor = faces('minorFont');
    // Per language: a script lookup costs microseconds, and a file may name a language on every run.
    const scripted = new Map<string, string | undefined>();
    return {
        font: (name, language) => {
            const collection = name.startsWith('major') ? major : name.startsWith('minor') ? minor : undefined;
            const kind = name.endsWith('Bidi') ? 'bidi' : name.endsWith('EastAsia') ? 'eastAsia' : undefined;
            if (!kind) return collection?.latin;
            const scriptLanguage = language ?? defaults[kind];
            const key = `${name} ${scriptLanguage}`;
            if (!scripted.has(key)) scripted.set(key, collection?.[kind](scriptLanguage));
            return scripted.get(key);
        },
    };
}

// A run's faces by what they draw: ASCII, the rest of Latin, Greek and Cyrillic (high ANSI), East Asian scripts and
// complex scripts. Each inherits on its own.
export type Fonts = { ascii?: string; hAnsi?: string; eastAsia?: string; cs?: string };

export const FONT_SLOTS = ['ascii', 'hAnsi', 'eastAsia', 'cs'] as const;

// What picks a face beside the character: a run marked complex script or right to left, and the eastAsia hint.
export type Script = { complex?: boolean; hint?: string };

const EAST_ASIAN =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]/u;
const COMPLEX =
    /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}]/u;
const SCRIPTED = new RegExp(`${EAST_ASIAN.source}|${COMPLEX.source}`, 'u');
const NON_ASCII = /\P{ASCII}/u;

// Word's face for a character (ECMA-376 17.3.2.26): its script's, the cs face for a complex run, and the East Asian
// face for the characters both draw under the eastAsia hint.
function fontSlot(char: string, script: Script): (typeof FONT_SLOTS)[number] {
    if (script.complex || COMPLEX.test(char)) return 'cs';
    if (EAST_ASIAN.test(char)) return 'eastAsia';
    if (char <= '\x7f') return 'ascii';
    return script.hint === 'eastAsia' ? 'eastAsia' : 'hAnsi';
}

function faceOf(fonts: Fonts | undefined, slot: (typeof FONT_SLOTS)[number]): string | undefined {
    if (slot === 'ascii') return fonts?.ascii ?? fonts?.hAnsi;
    if (slot === 'hAnsi') return fonts?.hAnsi ?? fonts?.ascii;
    return fonts?.[slot];
}

// A run's text in the faces Word draws it in, split where the face changes or, where the complex script draws in a
// look of its own (its bold, italic and size), where complex script starts or ends; Latin text in one face is one
// piece. split charges each piece past the first before it is built.
export function byFace(
    text: string,
    fonts: Fonts | undefined,
    script: Script,
    complexLook: boolean,
    split?: () => void,
): { text: string; font?: string; complex: boolean }[] {
    const latin = !script.complex && !SCRIPTED.test(text) && (script.hint !== 'eastAsia' || !NON_ASCII.test(text));
    if (latin && faceOf(fonts, 'ascii') === faceOf(fonts, 'hAnsi'))
        return [{ text, font: faceOf(fonts, 'ascii'), complex: false }];
    const pieces: { text: string; font?: string; complex: boolean }[] = [];
    let start = 0;
    let end = 0;
    for (const char of text) {
        const slot = fontSlot(char, script);
        const font = faceOf(fonts, slot);
        const complex = complexLook && slot === 'cs';
        const last = pieces.at(-1);
        if (!last || last.font !== font || last.complex !== complex) {
            if (last) {
                split?.();
                last.text = text.slice(start, end);
                start = end;
            }
            pieces.push({ text: '', font, complex });
        }
        end += char.length;
    }
    const last = pieces.at(-1);
    if (last) last.text = text.slice(start);
    return pieces;
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
// some variable sans, so a family counts only beside a known variable pitch. Script, decorative and auto are unknown.
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

export function bundledFontOf(name: string | undefined, fontTable?: FontTable): string | undefined {
    return name ? (bundledFont(name) ?? fontTable?.get(name.trim().toLowerCase())) : undefined;
}

// The document font draws without a mark, so a foreign sans body is no mark and a serif or mono one is one per run.
export function fontMark(name: string | undefined, fontTable?: FontTable): string | undefined {
    const font = bundledFontOf(name, fontTable);
    return font === DOCUMENT_FONT ? undefined : font;
}

// A symbol font's character as Unicode; Word's private-use spelling, U+F0xx, is the font's own xx.
export function symbolOf(font: string, code: number): string | undefined {
    return (dingbat(font, code) ?? (code >= 0xf000 && code <= 0xf0ff ? dingbat(font, code - 0xf000) : undefined))
        ?.string;
}
