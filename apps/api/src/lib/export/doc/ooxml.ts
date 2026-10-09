import { EIGEN_FONT_NAMES, getFontName } from '@workspace/lib/constants/fonts';
import { cssColorToHex } from '../colors';
import { proseValue } from './prose-css';

// The WordprocessingML the docx writer writes and the docx reader recognises, one source both ways: namespaces, style
// names, units and the editor's look in OOXML values, which a reader that drops custom styles keeps as direct formatting.

// ── Namespaces ──────────────────────────────────────────────────────────────────────────────────────────────────

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const ASVG_NS = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
export const V_NS = 'urn:schemas-microsoft-com:vml';
export const O_NS = 'urn:schemas-microsoft-com:office:office';
export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
export const PACKAGE_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

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

// A code block's language rides on a hidden style of its own, based on Code Block.
export function codeBlockStyle(language: string): { id: `CodeBlock-${string}`; name: string } {
    return { id: `CodeBlock-${language}`, name: `${STYLE_NAMES.CodeBlock} (${language})` };
}

const CODE_BLOCK_LANGUAGE = new RegExp(`^${STYLE_NAMES.CodeBlock} \\((.+)\\)$`, 'i');

export function codeBlockLanguage(styleName: string): string | undefined {
    return CODE_BLOCK_LANGUAGE.exec(styleName)?.[1];
}

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const TWIPS_PER_PX = 15;

export const EMU_PER_PX = 9525;

export const EMU_PER_TWIP = 635;

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

const TASK_DONE = 'ul[data-type="taskList"] li[data-checked="true"] > div';

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

export const CAPTION_LOOK = {
    sizePt: cssPt(proseValue('.eigen-prose figcaption', 'font-size'), BODY.sizePt),
    color: proseColor('.eigen-prose figcaption', 'color'),
};

export const HEADER_CELL_LOOK = { fill: proseColor('.eigen-prose th', 'background-color') };

export const LINK_LOOK = { color: proseColor('.eigen-prose a', 'color') };
