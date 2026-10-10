import { type XmlElement, xmlElements } from './xml';

// The OOXML vocabulary the docx writer writes and the readers recognise, one source both ways: namespaces, style
// names, list formats, units and Word's spelling of a number.

// ── Namespaces ──────────────────────────────────────────────────────────────────────────────────────────────────

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
// Word's drawing of a SmartArt, the shapes and their text as laid out.
export const DSP_NS = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
export const SML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const ASVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
export const V_NS = 'urn:schemas-microsoft-com:vml';
export const O_NS = 'urn:schemas-microsoft-com:office:office';
export const W10_NS = 'urn:schemas-microsoft-com:office:word';
export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const PACKAGE_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const CORE_PROPERTIES_NS = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
// Not a namespace: the uri of Word's compatibility settings.
export const WORD_SETTINGS_URI = 'http://schemas.microsoft.com/office/word';

const STRICT = 'http://purl.oclc.org/ooxml';

// Strict OOXML names the same vocabulary in other namespaces; read as transitional, it reads the same.
const STRICT_NAMESPACES = new Map([
    [`${STRICT}/wordprocessingml/main`, W_NS],
    [`${STRICT}/officeDocument/relationships`, R_NS],
    [`${STRICT}/drawingml/wordprocessingDrawing`, WP_NS],
    [`${STRICT}/drawingml/main`, A_NS],
    [`${STRICT}/drawingml/picture`, PIC_NS],
    [`${STRICT}/drawingml/chart`, C_NS],
    [`${STRICT}/drawingml/diagram`, DGM_NS],
    [`${STRICT}/officeDocument/math`, M_NS],
    [`${STRICT}/spreadsheetml/main`, SML_NS],
]);

export function toTransitional(root: XmlElement): void {
    const stack = [root];
    for (let element = stack.pop(); element; element = stack.pop()) {
        element.ns = STRICT_NAMESPACES.get(element.ns) ?? element.ns;
        if (Object.values(element.attributeNs).some((ns) => STRICT_NAMESPACES.has(ns)))
            element.attributeNs = Object.fromEntries(
                Object.entries(element.attributeNs).map(([name, ns]) => [name, STRICT_NAMESPACES.get(ns) ?? ns]),
            );
        for (const child of xmlElements(element)) stack.push(child);
    }
}

// ── Styles: Word lists a style by its name, which a re-save keeps where an id may change ────────────────────────────

export const STYLE_NAMES = {
    Normal: 'Normal',
    DefaultParagraphFont: 'Default Paragraph Font',
    TableNormal: 'Normal Table',
    NoList: 'No List',
    Quote: 'Quote',
    CodeBlock: 'Code Block',
    Caption: 'caption',
    HorizontalRule: 'Horizontal Rule',
    PageBreak: 'Page Break',
    Spacer: 'Spacer',
    TaskDone: 'Task Done',
    Hyperlink: 'Hyperlink',
    Code: 'Code',
} as const;

export type StyleId = keyof typeof STYLE_NAMES | `Heading${number}` | `CodeBlock-${string}`;

export function headingStyleName(level: number): string {
    return `heading ${level}`;
}

const HEADING_LEVEL = /^heading ([1-9])$/i;

export function headingLevel(styleName: string): number | undefined {
    const level = HEADING_LEVEL.exec(styleName)?.[1];
    return level === undefined ? undefined : Number(level);
}

// A code block's language rides on a hidden style of its own, based on Code Block.
export function codeBlockStyle(language: string): { id: `CodeBlock-${string}`; name: string } {
    return { id: `CodeBlock-${language}`, name: `${STYLE_NAMES.CodeBlock} (${language})` };
}

const CODE_BLOCK_LANGUAGE = new RegExp(`^${STYLE_NAMES.CodeBlock} \\((.+)\\)$`, 'i');

export function codeBlockLanguage(styleName: string): string | undefined {
    return CODE_BLOCK_LANGUAGE.exec(styleName)?.[1];
}

// ── Lists ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Word's levels, ilvl 0 to 8.
export const LIST_LEVELS = 9;

// An ordered list's type as Word's numFmt, and back; decimal is the default, which reads back as no type.
export const LIST_FORMATS = new Map([
    ['1', 'decimal'],
    ['a', 'lowerLetter'],
    ['A', 'upperLetter'],
    ['i', 'lowerRoman'],
    ['I', 'upperRoman'],
]);

export const LIST_TYPES = new Map(
    [...LIST_FORMATS].flatMap(([type, format]) => (format === 'decimal' ? [] : [[format, type] as const])),
);

// A number as a level of that numFmt shows it; a format spelled otherwise shows decimal.
export function spellNumber(value: number, format: string): string {
    switch (format) {
        case 'lowerLetter':
        case 'upperLetter': {
            // Word's 27th is aa, its 28th bb.
            const index = Math.max(1, value) - 1;
            const letters = String.fromCharCode(97 + (index % 26)).repeat(Math.floor(index / 26) + 1);
            return format === 'upperLetter' ? letters.toUpperCase() : letters;
        }
        case 'lowerRoman':
        case 'upperRoman': {
            const roman = toRoman(value);
            return format === 'upperRoman' ? roman : roman.toLowerCase();
        }
        case 'decimalZero':
            return value < 10 ? `0${value}` : String(value);
        case 'bullet':
        case 'none':
            return '';
        default:
            return String(value);
    }
}

const ROMAN_NUMERALS: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
];

function toRoman(value: number): string {
    if (value <= 0 || value >= 4000) return String(value);
    let rest = value;
    let roman = '';
    for (const [amount, numeral] of ROMAN_NUMERALS) {
        while (rest >= amount) {
            roman += numeral;
            rest -= amount;
        }
    }
    return roman;
}

// Word's checkbox, checked and not.
export const CHECKBOX_GLYPHS = { checked: '☒', unchecked: '☐' } as const;

// ── Formatting ─────────────────────────────────────────────────────────────────────────────────────────────────

// A highlight without a color: the UA's yellow <mark>, and Word's yellow highlight.
export const DEFAULT_HIGHLIGHT = 'FFFF00';

// Section types that start a new page; continuous and nextColumn don't, and a missing type is nextPage.
export const PAGE_SECTION_TYPES = new Set(['nextPage', 'oddPage', 'evenPage']);

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const TWIPS_PER_PX = 15;

export const EMU_PER_PX = 9525;

export const EMU_PER_TWIP = 635;

// ── Vocabulary the readers share ────────────────────────────────────────────────────────────────────────────────

// A paragraph's border sides, as pBdr orders them.
export const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

// The theme colors Word's link look names.
export const LINK_THEME_COLORS = new Set(['hyperlink', 'followedHyperlink']);

// ST_OnOff attribute value: 1, true, on / 0, false, off, whitespace around it allowed; anything else is no answer.
export function isOn(value: string | undefined): boolean | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined) return undefined;
    if (['1', 'true', 'on'].includes(trimmed)) return true;
    return ['0', 'false', 'off'].includes(trimmed) ? false : undefined;
}
