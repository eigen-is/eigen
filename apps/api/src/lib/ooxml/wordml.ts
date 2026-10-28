// Word's vocabulary, one source for the docx writer that writes it and the docx reader that recognizes it. It holds,
// for example, the content types, the style names, Word's spelling of a list number and the table of contents field.
// The OOXML every format shares sits in its own module.

import type { EigenFont } from '@workspace/lib/constants/fonts';
import type { CellBorderStyle, PageNumberKind } from '@workspace/lib/docs/eigendoc';
import { ptToTwips, pxToPt, readTocLevels } from '@workspace/lib/docs/eigendoc';

// The prefix of WordprocessingML's content types.
export const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

// The uri of Word's compatibility settings, which looks like a namespace but is not one.
export const WORD_SETTINGS_URI = 'http://schemas.microsoft.com/office/word';

// w:view's Web Layout, ST_View's "Web Page View": the view a page-less doc's docx opens in, and imports page-less from.
export const WEB_VIEW = 'web';

// ── Styles ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Word lists a style by its name. A re-save keeps the name, while the id may change.

export const STYLE_NAMES = {
    Normal: 'Normal',
    DefaultParagraphFont: 'Default Paragraph Font',
    TableNormal: 'Normal Table',
    NoList: 'No List',
    Title: 'Title',
    Subtitle: 'Subtitle',
    Quote: 'Quote',
    CodeBlock: 'Code Block',
    Caption: 'caption',
    HorizontalRule: 'Horizontal Rule',
    PageBreak: 'Page Break',
    Spacer: 'Spacer',
    TaskDone: 'Task Done',
    // A header cell's paragraphs in a row with a body cell, which w:tblHeader can't mark.
    TableHeader: 'Table Header',
    Hyperlink: 'Hyperlink',
    Code: 'Code',
    FootnoteText: 'footnote text',
    FootnoteReference: 'footnote reference',
} as const;

export type StyleId = keyof typeof STYLE_NAMES | `Heading${number}` | `TOC${number}` | `CodeBlock-${string}`;

export function headingStyleName(level: number): string {
    return `heading ${level}`;
}

const HEADING_LEVEL = /^heading ([1-9])$/i;

export function headingLevel(styleName: string): number | undefined {
    const level = HEADING_LEVEL.exec(styleName)?.[1];
    return level === undefined ? undefined : Number(level);
}

// Eigen's headings go to level 6, where Word's go to 9.
export const DEEPEST_HEADING_LEVEL = 6;

// Word's outline level of body text. A paragraph at any lower level is listed in Word's navigation pane.
export const BODY_TEXT_OUTLINE_LEVEL = 9;

// Word's built-in style of a table of contents entry for a heading at `level`.
export function tocStyleName(level: number): string {
    return `toc ${level}`;
}

const TOC_LEVEL = /^toc ([1-9])$/i;

export function tocLevel(styleName: string): number | undefined {
    const level = TOC_LEVEL.exec(styleName)?.[1];
    return level === undefined ? undefined : Number(level);
}

// A code block's language is kept in a hidden style of its own, based on Code Block.
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

// An ordered list's type as Word's numFmt, and back.
export const LIST_FORMATS = new Map([
    ['1', 'decimal'],
    ['a', 'lowerLetter'],
    ['A', 'upperLetter'],
    ['i', 'lowerRoman'],
    ['I', 'upperRoman'],
]);

export const LIST_TYPES = new Map([...LIST_FORMATS].map(([type, format]) => [format, type]));

// A number as a list level of that numFmt shows it. Any other format shows it as a decimal.
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

// The color of a highlight that names none: the browser's yellow <mark>, which is also Word's yellow highlight.
export const DEFAULT_HIGHLIGHT = 'FFFF00';

// A paragraph's w:jc for each of the editor's text alignments.
export const JUSTIFICATION = new Map([
    ['left', 'left'],
    ['center', 'center'],
    ['right', 'right'],
    ['justify', 'both'],
]);

// A w:jc as the editor's text alignment. Left is the default, so it is null, the editor's unset value; Google Docs
// writes it on every paragraph. Start and end follow the paragraph's direction.
export function textAlignOf(jc: string | undefined, bidi: boolean | undefined): string | null {
    switch (jc) {
        case 'center':
            return 'center';
        case 'right':
            return 'right';
        case 'start':
            return bidi ? 'right' : null;
        case 'end':
            return bidi ? null : 'right';
        case 'both':
        case 'distribute':
            return 'justify';
        default:
            return null;
    }
}

// The section types that start a new page. Continuous and nextColumn don't, and a missing type means nextPage.
export const PAGE_SECTION_TYPES = new Set(['nextPage', 'oddPage', 'evenPage']);

// The field each page number kind writes, as w:instr names it.
export const PAGE_NUMBER_FIELDS: Record<PageNumberKind, string> = { page: 'PAGE', pages: 'NUMPAGES' };

// A table of contents as Word writes its field: the headings to `levels` by outline level (\o), each entry a link (\h),
// no page numbers in Web Layout (\z), and paragraphs given an outline level directly (\u). It stands in a content
// control of Word's gallery, so Word's Update Table and its references pane find it.
export function tocInstruction(levels: number): string {
    return `TOC \\o "1-${levels}" \\h \\z \\u`;
}

// A field's name is case-insensitive.
const TOC_FIELD = /^TOC\b/i;

export function isTocField(code: string): boolean {
    return TOC_FIELD.test(code.trim());
}

// A table of contents' deepest level, read from its field: \o "a-b" lists to b, a bare \o every level and none Word's
// default 1 to 3. A \t switch's numbers are the levels its styles list at, not headings'. A table of figures (\c or
// \a) is no table of contents, so it has none.
export function tocFieldLevels(code: string): number | undefined {
    if (!isTocField(code) || /\\[ac]\b/i.test(code)) return undefined;
    const outline = /\\o\b(?:\s*"\s*\d+\s*-\s*(\d+)\s*")?/i.exec(code);
    if (!outline) return readTocLevels(undefined);
    return outline[1] === undefined ? DEEPEST_HEADING_LEVEL : readTocLevels(Number(outline[1]));
}

export const TOC_GALLERY = 'Table of Contents';

// The bookmark on the Nth heading of the outline, which its entry links to and its PAGEREF field reads the page of.
export function tocBookmark(number: number): string {
    return `_Toc${number}`;
}

// What Word's field shows for a doc with no headings.
export const NO_TOC_ENTRIES = 'No table of contents entries found.';

// Word's widest table. The reader and the writer cap a table's grid at it, so no row walks or fills a column past it.
export const MAX_TABLE_COLUMNS = 63;

// How Eigen writes a column with no stored width: ECMA's No Width on its cells' w:tcW, so the grid holds only its
// layout. Word's own auto is a width Word lays out, so the reader reads it as a width.
export const NO_STORED_WIDTH = 'nil';

// The notes in a notes part that no reference names. They are the rule above the notes, the rule above a note that
// a page break continues, and the notice under such a note. Word writes the first two as notes -1 and 0 and names
// them in its settings.
export const NOTE_SEPARATORS = ['separator', 'continuationSeparator', 'continuationNotice'] as const;

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const TWIPS_PER_PX = ptToTwips(pxToPt(1));

// A border's w:sz counts in eighths of a point.
export const BORDER_EIGHTHS_PER_PX = pxToPt(1) * 8;

// Word's border styles, by the style the editor draws each as. The writer writes a style's first. The reader reads
// every listed one as its style, and any other, such as a 3-D or an art border, as solid.
export const WORD_BORDER_STYLES: Record<CellBorderStyle, readonly [string, ...string[]]> = {
    solid: ['single'],
    dashed: ['dashed', 'dashSmallGap', 'dashDotStroked', 'dotDash', 'dotDotDash'],
    dotted: ['dotted'],
    double: [
        'double',
        'doubleWave',
        'triple',
        'thinThickSmallGap',
        'thickThinSmallGap',
        'thinThickThinSmallGap',
        'thinThickMediumGap',
        'thickThinMediumGap',
        'thinThickThinMediumGap',
        'thinThickLargeGap',
        'thickThinLargeGap',
        'thinThickThinLargeGap',
    ],
};

export const EMU_PER_TWIP = 635;

// An auto w:line counts in 240ths of a single line.
export const SINGLE_LINE = 240;

// A run that states no w:sz draws at Word's 10 pt, which w:sz counts in half-points.
export const DEFAULT_RUN_SIZE = 20;

// ── Borders, fonts, drawings and links ──────────────────────────────────────────────────────────────────────────

// A paragraph's border sides, as pBdr orders them.
export const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

// A font's category as fontTable.xml's w:family names it.
export const FONT_FAMILY: Record<EigenFont['category'], string> = {
    'sans-serif': 'swiss',
    serif: 'roman',
    monospace: 'modern',
    'hand-drawn': 'script',
};

// The wraps that float a drawing beside the text.
export const FLOATING_WRAPS = new Set(['wrapSquare', 'wrapTight', 'wrapThrough']);

// The theme colors Word's link look names.
export const LINK_THEME_COLORS = new Set(['hyperlink', 'followedHyperlink']);
