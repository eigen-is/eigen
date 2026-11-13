// The editor's look in OOXML values, from the editor's prose stylesheet: the writer draws it, and the reader
// recognizes it where a re-save drops the writer's styles and keeps it as direct formatting. It also holds the rough
// measures of that look the exports estimate with, such as a character's width.

import type { JSONContent } from '@tiptap/core';
import { EIGEN_FONT_NAMES, FOOTNOTE_FONT_SIZE, getFontName } from '@workspace/lib/constants/fonts';
import type { NormalStyle, TitleType } from '@workspace/lib/docs/eigendoc';
import {
    DOC_PROSE_CLASS,
    LINE_SPACING_PROPERTY,
    listTypeOfStyle,
    ptToPx,
    ptToTwips,
    readParagraphFormat,
} from '@workspace/lib/docs/eigendoc';
import { LIST_FORMATS, LIST_LEVELS, SINGLE_LINE, TWIPS_PER_PX } from '../ooxml/wordml';
import { cssColorToHex } from './colors';
import { proseValue, proseValueIfSet } from './prose-css';

// rem against the 16 px root, px at 96 dpi, em against the element's own size.
export function cssPt(length: string, emPt: number): number {
    if (length.trim() === '0') return 0;
    const match = length.trim().match(/^(-?[\d.]+)(rem|em|px|pt)$/);
    if (!match) throw new Error(`eigen-prose.css length ${length} has no docx unit`);
    const [, value, unit] = match;
    return Number(value) * (unit === 'rem' ? 12 : unit === 'em' ? emPt : unit === 'px' ? 0.75 : 1);
}

export function twips(pt: number): number {
    return Math.round(ptToTwips(pt));
}

export function halfPoints(pt: number): number {
    return Math.round(pt * 2);
}

// sz in eighths of a point, space in points.
export type WordBorder = { sz: number; space: number; color: string };

export function proseColor(selector: string, property: string): string {
    const value = proseValue(selector, property);
    const hex = cssColorToHex(value);
    if (!hex) throw new Error(`eigen-prose.css color ${value} on ${selector} has no docx spelling`);
    return hex;
}

function proseFont(selector: string): string {
    const name = getFontName(proseValue(selector, 'font-family'));
    if (!EIGEN_FONT_NAMES.includes(name))
        throw new Error(`eigen-prose.css font ${name} on ${selector} is no Eigen font`);
    return name;
}

// One side of a box shorthand (margin, padding): one to four values, clockwise from the top.
export function boxSide(shorthand: string, side: 'top' | 'right' | 'bottom' | 'left'): string {
    const [top = '', right = top, bottom = top, left = right] = shorthand.trim().split(/\s+/);
    return { top, right, bottom, left }[side];
}

// A character's average width as a share of its font's size, for a rough count of a text's lines. Each is set wide, so
// the count errs long. The Normal's face draws narrower than the widest bundled face, a monospace one. A text box's
// height counts its text in the Normal's face, and whether the notes fit on a page counts in any face a run may use.
export const CHARACTER_WIDTH_EM = { normal: 0.55, anyFace: 0.6 };

// The prose body, the size every em in the body text is of.
export const BODY = {
    font: proseFont('.eigen-prose'),
    sizePt: cssPt(proseValue('.eigen-prose', 'font-size'), 12),
    color: proseColor('.eigen-prose', 'color'),
};

// A length an element in the body text takes, in twips.
export function proseTwips(selector: string, property: string): number {
    return twips(cssPt(proseValue(selector, property), BODY.sizePt));
}

// A solid border shorthand, its width in eighths of a point.
export function proseBorder(selector: string, property: string): Omit<WordBorder, 'space'> {
    const value = proseValue(selector, property);
    const [width = '', style, color = ''] = value.trim().split(/\s+/);
    if (style !== 'solid') throw new Error(`eigen-prose.css border ${value} on ${selector} has no docx spelling`);
    const hex = cssColorToHex(color);
    if (!hex) throw new Error(`eigen-prose.css border color ${color} on ${selector} has no docx spelling`);
    return { sz: Math.round(cssPt(width, BODY.sizePt) * 8), color: hex };
}

// ── The editor's look ───────────────────────────────────────────────────────────────────────────────────────────

// The bar is the left border and the padding its space; the indent puts the bar where the editor draws it.
function quoteLook() {
    const border = proseBorder('.eigen-prose blockquote', 'border-left');
    const space = Math.round(cssPt(proseValue('.eigen-prose blockquote', 'padding-left'), BODY.sizePt));
    return {
        border: { ...border, space },
        indent: twips(space + border.sz / 8),
        italic: proseValue('.eigen-prose blockquote', 'font-style') === 'italic',
        color: proseColor('.eigen-prose blockquote', 'color'),
    };
}

export const QUOTE_LOOK = quoteLook();

const TASK_DONE = 'ul[data-type="taskList"] li[data-checked="true"] > div > :not([data-type="taskList"])';

// The editor strikes a checked item's whole content in the muted color.
export const TASK_DONE_LOOK = {
    strike: proseValue(TASK_DONE, 'text-decoration') === 'line-through',
    color: proseColor(TASK_DONE, 'color'),
};

export const CODE_LOOK = {
    font: proseFont('.eigen-prose code'),
    color: proseColor('.eigen-prose code', 'color'),
    sizePt: cssPt(proseValue('.eigen-prose code', 'font-size'), BODY.sizePt),
    shading: proseColor('.eigen-prose code', 'background-color'),
};

const CODE_BORDER_EIGHTHS = 4;

// Shading stops at borders, so borders in the fill carry it over the padding; the indent sets the box on the column.
function codeBlockLook() {
    const padding = proseValue('.eigen-prose pre', 'padding');
    const fill = proseColor('.eigen-prose pre', 'background-color');
    const border = (side: 'top' | 'left') => ({
        sz: CODE_BORDER_EIGHTHS,
        space: Math.round(cssPt(boxSide(padding, side), BODY.sizePt)),
        color: fill,
    });
    const [vertical, horizontal] = [border('top'), border('left')];
    return {
        fill,
        borders: { top: vertical, left: horizontal, bottom: vertical, right: horizontal },
        indent: twips(horizontal.space + CODE_BORDER_EIGHTHS / 8),
    };
}

export const CODE_BLOCK_LOOK = codeBlockLook();

function smallLook() {
    const sizePt = cssPt(proseValue('.eigen-prose small', 'font-size'), BODY.sizePt);
    return { sizePt, letterSpacingPt: cssPt(proseValue('.eigen-prose small', 'letter-spacing'), sizePt) };
}

export const SMALL_LOOK = smallLook();

export const CAPTION_LOOK = {
    sizePt: cssPt(proseValue('.eigen-prose figcaption', 'font-size'), BODY.sizePt),
    color: proseColor('.eigen-prose figcaption', 'color'),
};

// A note's text is Word's FootnoteText, single spaced with no space after, at the footnote size Google's notes take
// too. eigen-prose.css can't give it, as the editor lists its notes off the page's prose.
export const FOOTNOTE_LOOK = { sizePt: FOOTNOTE_FONT_SIZE, line: SINGLE_LINE, after: 0 };

type TextLook = { color?: string; italic?: true };

// The color and italic eigen-prose.css gives an element's text, where it gives any: a highlighted code token's, a heading's.
export function proseTextLook(selector: string): TextLook {
    return {
        ...(proseValueIfSet(selector, 'color') !== undefined && { color: proseColor(selector, 'color') }),
        ...(proseValueIfSet(selector, 'font-style') === 'italic' && { italic: true }),
    };
}

// Each heading level's own look, by level - 1: Heading 5 and 6 draw Google Docs' gray, and 6 italic.
export const HEADING_LOOKS = [1, 2, 3, 4, 5, 6].map((level) => proseTextLook(`.eigen-prose h${level}`));

export const TITLE_SELECTORS: Record<TitleType, string> = {
    title: '.eigen-prose p[data-type="title"]',
    subtitle: '.eigen-prose p[data-type="subtitle"]',
};

// The title's and subtitle's own look, by node: the subtitle draws Google Docs' gray.
export const TITLE_LOOKS: Record<TitleType, TextLook> = {
    title: proseTextLook(TITLE_SELECTORS.title),
    subtitle: proseTextLook(TITLE_SELECTORS.subtitle),
};

// The look a text node draws its text in, which no mark carries; an italic one draws an italic mark upright. Word's
// Heading 7 to 9 are an Eigen Heading 6.
export function nodeLook(type: string, level = 1): TextLook {
    if (type === 'heading') return HEADING_LOOKS[Math.min(level, HEADING_LOOKS.length) - 1] ?? {};
    return type === 'title' || type === 'subtitle' ? TITLE_LOOKS[type] : {};
}

// A line spacing as Word's auto line, 240ths of the font's own single line. Eigen draws a line spacing the same way,
// so the two are one number: Google Docs reads every atLeast as single.
export function autoLine(lineSpacing: number): number {
    return Math.round(SINGLE_LINE * lineSpacing);
}

// A heading's or title's size, spacing and auto line. One without its own size inherits the prose root's, as h5 and h6
// do, so its size is the Normal's.
export function textMetrics(selector: string, normalPt: number) {
    const size = proseValueIfSet(selector, 'font-size');
    const sizePt = size === undefined ? normalPt : cssPt(size, BODY.sizePt);
    const tracking = proseValueIfSet(selector, 'letter-spacing');
    return {
        sizePt,
        before: twips(cssPt(proseValue(selector, 'margin-top'), sizePt)),
        after: twips(cssPt(proseValue(selector, 'margin-bottom'), sizePt)),
        line: autoLine(Number(proseValue(selector, LINE_SPACING_PROPERTY))),
        tracking: tracking === undefined ? undefined : twips(cssPt(tracking, sizePt)),
    };
}

// The size in points, the space before and after in twips, and the line an auto line.
type OwnLook = { sizePt: number; before: number; after: number; line: number };

// What a text node draws with no mark or format of its own. The docx writer's styles write it, so the reader and the
// audit read it as no format.
export function ownTextLook(type: string, level: number, normal: NormalStyle, inNote: boolean): OwnLook | undefined {
    if (inNote) return noteTextLook(normal);
    if (type === 'paragraph') return normalTextLook(normal);
    if (type === 'heading') return textMetrics(`.eigen-prose h${Math.min(level, HEADING_LOOKS.length)}`, normal.size);
    return type === 'title' || type === 'subtitle' ? textMetrics(TITLE_SELECTORS[type], normal.size) : undefined;
}

export function normalTextLook(normal: NormalStyle): OwnLook {
    return {
        sizePt: normal.size,
        before: twips(normal.spaceBefore),
        after: twips(normal.spaceAfter),
        line: autoLine(normal.lineSpacing),
    };
}

export function noteTextLook(normal: NormalStyle): OwnLook {
    return {
        sizePt: FOOTNOTE_LOOK.sizePt,
        before: twips(normal.spaceBefore),
        after: FOOTNOTE_LOOK.after,
        line: FOOTNOTE_LOOK.line,
    };
}

export const HEADER_CELL_LOOK = { fill: proseColor('.eigen-prose th', 'background-color') };

// The side a cell draws when it stores none of its own.
export const CELL_BORDER = proseBorder('.eigen-prose td', 'border');

const CELL_PADDING = proseValue('.eigen-prose td', 'padding');

// A cell's padding in twips: a table nested in a cell fits inside it.
export const TABLE_CELL_PADDING = {
    vertical: twips(cssPt(boxSide(CELL_PADDING, 'top'), BODY.sizePt)),
    horizontal: twips(cssPt(boxSide(CELL_PADDING, 'left'), BODY.sizePt)),
};

// In twips: the margin above and below a block figure, which the paragraph holding it draws.
const FIGURE_MARGIN_CSS = proseValue('.eigen-prose .figure', 'margin');
export const FIGURE_MARGIN = {
    top: twips(cssPt(boxSide(FIGURE_MARGIN_CSS, 'top'), BODY.sizePt)),
    bottom: twips(cssPt(boxSide(FIGURE_MARGIN_CSS, 'bottom'), BODY.sizePt)),
};

// In twips: the writer spaces the block after an in-flow table by it, and the reader takes that space as the table's.
export const TABLE_MARGIN = twips(cssPt(boxSide(proseValue('.eigen-prose table', 'margin'), 'bottom'), BODY.sizePt));

// In twips: the margin the writer gives an outermost list's and a quote's last block, and to a table that ends one, so
// the block after it.
export const BLOCK_MARGINS = {
    ul: twips(cssPt(proseValue('.eigen-prose ul', 'margin-bottom'), BODY.sizePt)),
    ol: twips(cssPt(proseValue('.eigen-prose ol', 'margin-bottom'), BODY.sizePt)),
    blockquote: twips(cssPt(proseValue('.eigen-prose blockquote', 'margin-bottom'), BODY.sizePt)),
};

// In twips: the indent a list level adds to the text of its items.
export const LIST_LEVEL = proseTwips('.eigen-prose ul', 'padding-left');

// ── A figure in front of or behind the text ─────────────────────────────────────────────────────────────────────
// Eigen places one from its anchor paragraph's padding box. Word places it from the text column and from the top of
// the paragraph's space before. The writer converts one way with these and the reader the other.

// How far right of the text column the paragraph's box starts, in px: its container's indent, a list's or a quote's,
// in twips, and its own left indent, if it has one.
export function anchorIndentPx(container: number, textblock: JSONContent | undefined): number {
    const { indentLeft } = readParagraphFormat(textblock?.attrs ?? {});
    return container / TWIPS_PER_PX + ptToPx(indentLeft ?? 0);
}

// The padding above the paragraph's text, in px: its own space before, or for a paragraph the Normal's. In a list or a
// quote it draws none.
export function anchorPaddingPx(textblock: JSONContent, contained: boolean, normal: NormalStyle): number {
    if (contained) return 0;
    const { spaceBefore } = readParagraphFormat(textblock.attrs ?? {});
    return ptToPx(spaceBefore ?? (textblock.type === 'paragraph' ? normal.spaceBefore : 0));
}

export const LINK_LOOK = {
    color: proseColor('.eigen-prose a', 'color'),
    underline: proseValue('.eigen-prose a', 'text-decoration') === 'underline',
};

// eigen-prose.css numbers a list that stores no type by the numbered lists it sits in: `ol`, then Docs' `ol ol` and on.
const UNTYPED_LIST_FORMATS = Array.from({ length: LIST_LEVELS }, (_, depth) => {
    const nested = Array(depth + 1)
        .fill('ol')
        .join(' ');
    const style = proseValue(depth === 0 ? '.eigen-prose ol' : `.${DOC_PROSE_CLASS} ${nested}`, 'list-style-type');
    const format = LIST_FORMATS.get(listTypeOfStyle(style) ?? '');
    if (!format) throw new Error(`eigen-prose.css numbers a list in ${style}, which Word has no format for`);
    return format;
});

// The numFmt an untyped list draws in, `numbered` lists deep; past Word's levels as its last.
export function untypedListFormat(numbered: number): string {
    return UNTYPED_LIST_FORMATS[Math.min(numbered, LIST_LEVELS - 1)] ?? 'decimal';
}
