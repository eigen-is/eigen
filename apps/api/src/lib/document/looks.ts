// The editor's look in OOXML values, from eigen-prose.css: the writer draws it, and the reader recognises it where a
// re-save drops the writer's styles and keeps it as direct formatting.

import {
    DOCUMENT_LINE_RATIO,
    EIGEN_FONT_NAMES,
    FOOTNOTE_FONT_SIZE,
    fontLineHeight,
    getFontName,
} from '@workspace/lib/constants/fonts';
import type { NormalStyle, TitleType } from '@workspace/lib/docs/eigendoc';
import { DOC_PROSE_CLASS, listTypeOfStyle, ptToTwips } from '@workspace/lib/docs/eigendoc';
import { LIST_FORMATS, LIST_LEVELS, SINGLE_LINE } from '../ooxml/wordml';
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
export type Border = { sz: number; space: number; color: string };

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

// The prose body, the size every em in the body text is of.
export const BODY = {
    font: proseFont('.eigen-prose'),
    sizePt: cssPt(proseValue('.eigen-prose', 'font-size'), 12),
    color: proseColor('.eigen-prose', 'color'),
};

// A solid border shorthand, its width in eighths of a point.
export function proseBorder(selector: string, property: string): Omit<Border, 'space'> {
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

// Each heading level's own look, by level - 1: Heading 5 and 6 draw Google Docs' grey, and 6 italic.
export const HEADING_LOOKS = [1, 2, 3, 4, 5, 6].map((level) => proseTextLook(`.eigen-prose h${level}`));

export const TITLE_SELECTORS: Record<TitleType, string> = {
    title: '.eigen-prose p[data-type="title"]',
    subtitle: '.eigen-prose p[data-type="subtitle"]',
};

// The title's and subtitle's own look, by node: the subtitle draws Google Docs' grey.
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

export function lineHeightPt(value: string, sizePt: number): number {
    return /^[\d.]+$/.test(value) ? Number(value) * sizePt : cssPt(value, sizePt);
}

// A heading or title without its own size or line height inherits the prose root's, as h5 and h6 do: its size the
// Normal's.
export function textMetrics(selector: string, normalPt: number) {
    const size = proseValueIfSet(selector, 'font-size');
    const sizePt = size === undefined ? normalPt : cssPt(size, BODY.sizePt);
    const line = proseValueIfSet(selector, 'line-height') ?? proseValue('.eigen-prose', 'line-height');
    const tracking = proseValueIfSet(selector, 'letter-spacing');
    return {
        sizePt,
        before: twips(cssPt(proseValue(selector, 'margin-top'), sizePt)),
        after: twips(cssPt(proseValue(selector, 'margin-bottom'), sizePt)),
        line: lineHeightPt(line, sizePt),
        tracking: tracking === undefined ? undefined : twips(cssPt(tracking, sizePt)),
    };
}

// A multiple of the font's own line height, so the pitch is the CSS one: Google Docs reads every atLeast as single.
export function autoLine(linePt: number, sizePt: number, font: string): number {
    return Math.round((SINGLE_LINE * linePt) / (sizePt * fontLineHeight(font)));
}

// A line spacing, which CSS draws in Inter's line, in the Normal's font, as Word draws it.
export function normalLine(lineSpacing: number, normal: NormalStyle): number {
    return autoLine(lineSpacing * DOCUMENT_LINE_RATIO * normal.size, normal.size, normal.font);
}

// normalLine's inverse: the line spacing an auto line written in this font draws.
export function lineMultiple(written: number, font: string): number {
    return (written * fontLineHeight(font)) / DOCUMENT_LINE_RATIO / SINGLE_LINE;
}

// A run's family and size in half-points, which the height of its line follows.
export type RunFace = { family: string; size: number };

// Word draws an auto line in the tallest face on it, the paragraph mark's included; CSS draws its line at the largest
// size alone, in the mark's family. The writer writes the line of a paragraph all in one family times this, and the
// reader divides it back out. Mixed families are 1: the writer leaves their line alone.
export function familyLineScale(mark: RunFace, faces: RunFace[]): number {
    const family = faces[0]?.family;
    if (family === undefined || faces.some((face) => face.family !== family)) return 1;
    let tallest = fontLineHeight(mark.family) * mark.size;
    let largest = mark.size;
    for (const face of faces) {
        tallest = Math.max(tallest, fontLineHeight(face.family) * face.size);
        largest = Math.max(largest, face.size);
    }
    return (fontLineHeight(mark.family) * largest) / tallest;
}

type OwnLook = { sizePt: number; before: number; after: number; line: number };

// What a text node draws with no mark or format of its own, which the docx writer's styles write, and so what the reader
// and the audit take as none: its size in points, its space before and after in twips and its auto line in the
// Normal's font. A note's paragraph draws Word's FootnoteText over the Normal.
export function ownTextLook(type: string, level: number, normal: NormalStyle, inNote: boolean): OwnLook | undefined {
    if (inNote) return noteTextLook(normal);
    if (type === 'paragraph') return normalTextLook(normal);
    if (type === 'heading') return sizedTextLook(`.eigen-prose h${Math.min(level, HEADING_LOOKS.length)}`, normal);
    return type === 'title' || type === 'subtitle' ? sizedTextLook(TITLE_SELECTORS[type], normal) : undefined;
}

export function normalTextLook(normal: NormalStyle): OwnLook {
    return {
        sizePt: normal.size,
        before: twips(normal.spaceBefore),
        after: twips(normal.spaceAfter),
        line: normalLine(normal.lineSpacing, normal),
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

// A heading's or a title's, by its selector, with its letter spacing.
export function sizedTextLook(selector: string, normal: NormalStyle): OwnLook & { tracking: number | undefined } {
    const metrics = textMetrics(selector, normal.size);
    return { ...metrics, line: autoLine(metrics.line, metrics.sizePt, normal.font) };
}

export const HEADER_CELL_LOOK = { fill: proseColor('.eigen-prose th', 'background-color') };

const CELL_PADDING = proseValue('.eigen-prose td', 'padding');

// A cell's padding in twips: a table nested in a cell fits inside it.
export const TABLE_CELL_PADDING = {
    vertical: twips(cssPt(boxSide(CELL_PADDING, 'top'), BODY.sizePt)),
    horizontal: twips(cssPt(boxSide(CELL_PADDING, 'left'), BODY.sizePt)),
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

export const LINK_LOOK = { color: proseColor('.eigen-prose a', 'color') };

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
