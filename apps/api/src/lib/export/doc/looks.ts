import { EIGEN_FONT_NAMES, getFontName } from '@workspace/lib/constants/fonts';
import { cssColorToHex } from '../colors';
import { proseValue } from './prose-css';

// The editor's look in OOXML values, from eigen-prose.css: the writer draws it, and the reader recognises it where a
// re-save drops the writer's styles and keeps it as direct formatting.

// rem against the 16 px root, px at 96 dpi, em against the element's own size.
export function cssPt(length: string, emPt: number): number {
    if (length.trim() === '0') return 0;
    const match = length.trim().match(/^(-?[\d.]+)(rem|em|px|pt)$/);
    if (!match) throw new Error(`eigen-prose.css length ${length} has no docx unit`);
    const [, value, unit] = match;
    return Number(value) * (unit === 'rem' ? 12 : unit === 'em' ? emPt : unit === 'px' ? 0.75 : 1);
}

export function twips(pt: number): number {
    return Math.round(pt * 20);
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

export function proseFont(selector: string): string {
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

export const HEADER_CELL_LOOK = { fill: proseColor('.eigen-prose th', 'background-color') };

export const LINK_LOOK = { color: proseColor('.eigen-prose a', 'color') };
