// A doc's table cells: TipTap's cell and header with the look a cell keeps of its own, its fill and its four border
// sides. The editor and every server renderer draw a cell through these nodes, and the docx reader and writer store
// and read the same attributes. A peer or a paste can write any value, so every reader of an attribute goes through
// readCellBackground or readCellBorder, which keep only the stored form.

import { TableCell, TableHeader } from '@tiptap/extension-table';

const HEX_COLOR = /^#[0-9a-f]{6}$/;
// A browser spells a style's color as rgb(), whatever the HTML wrote.
const RGB_COLOR = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/;

const CELL_BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const;
type CellBorderStyle = (typeof CELL_BORDER_STYLES)[number];

// A side Eigen draws in its own look is null; a side the cell sets is a border or none.
export type CellBorder = 'none' | { width: number; style: CellBorderStyle; color: string };

// In px: Word's thinnest and thickest borders, a quarter point and twelve, clamped to what still draws on screen.
export const MIN_CELL_BORDER_PX = 0.5;
export const MAX_CELL_BORDER_PX = 8;

// Each side's attribute, in CSS's clockwise order.
export const CELL_BORDER_SIDES = [
    ['borderTop', 'top'],
    ['borderRight', 'right'],
    ['borderBottom', 'bottom'],
    ['borderLeft', 'left'],
] as const;
export type CellBorderAttribute = (typeof CELL_BORDER_SIDES)[number][0];
export type CellSide = (typeof CELL_BORDER_SIDES)[number][1];

const CELL_BORDER = /^(\d{1,3}(?:\.\d{1,2})?)px (solid|dashed|dotted|double) (#[0-9a-f]{6})$/;

// A cell's fill as stored: a peer or a paste writes any value, and it lands in a style and a docx's w:shd.
export function readCellBackground(value: unknown): string | null {
    const color = typeof value === 'string' ? value.toLowerCase() : '';
    return HEX_COLOR.test(color) ? color : null;
}

// A side as stored, "<px>px <style> <#rrggbb>" or "none": it lands in a style and a docx's w:tcBorders.
export function readCellBorder(value: unknown): CellBorder | null {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    if (text === 'none') return 'none';
    const [, width, written, color] = CELL_BORDER.exec(text) ?? [];
    const style = CELL_BORDER_STYLES.find((known) => known === written);
    const px = Number(width);
    if (!style || !color || px < MIN_CELL_BORDER_PX || px > MAX_CELL_BORDER_PX) return null;
    return { width: px, style, color };
}

export function cellBorderValue(border: CellBorder): string {
    return border === 'none' ? 'none' : `${Number(border.width.toFixed(2))}px ${border.style} ${border.color}`;
}

function hexOf(color: string): string | null {
    const rgb = RGB_COLOR.exec(color);
    if (!rgb) return readCellBackground(color);
    return readCellBackground(
        `#${rgb
            .slice(1)
            .map((channel) => Number(channel).toString(16).padStart(2, '0'))
            .join('')}`,
    );
}

// A pasted side, Google Docs' in points: one 0 wide, or of style none or hidden, draws none.
function parseCellBorder(element: HTMLElement, side: string): string | null {
    const style = element.style.getPropertyValue(`border-${side}-style`);
    const width = /^(\d*\.?\d+)(px|pt)$/.exec(element.style.getPropertyValue(`border-${side}-width`));
    if (style === 'none' || style === 'hidden' || (width && Number(width[1]) === 0)) return 'none';
    const color = hexOf(element.style.getPropertyValue(`border-${side}-color`));
    if (!width || !color || !CELL_BORDER_STYLES.some((known) => known === style)) return null;
    const px = Number(width[1]) * (width[2] === 'pt' ? 4 / 3 : 1);
    const border = readCellBorder(
        `${Number(Math.min(Math.max(px, MIN_CELL_BORDER_PX), MAX_CELL_BORDER_PX).toFixed(2))}px ${style} ${color}`,
    );
    return border && cellBorderValue(border);
}

const backgroundColor = {
    default: null,
    parseHTML: (element: HTMLElement) => hexOf(element.style.backgroundColor),
    renderHTML: (attributes: Record<string, unknown>) => {
        const color = readCellBackground(attributes['backgroundColor']);
        return color ? { style: `background-color: ${color}` } : {};
    },
};

const borders = Object.fromEntries(
    CELL_BORDER_SIDES.map(([name, side]) => [
        name,
        {
            default: null,
            parseHTML: (element: HTMLElement) => parseCellBorder(element, side),
            renderHTML: (attributes: Record<string, unknown>) => {
                const border = readCellBorder(attributes[name]);
                return border ? { style: `border-${side}: ${cellBorderValue(border)}` } : {};
            },
        },
    ]),
);

export const EigenTableCell = TableCell.extend({
    addAttributes() {
        return { ...this.parent?.(), backgroundColor, ...borders };
    },
});

export const EigenTableHeader = TableHeader.extend({
    addAttributes() {
        return { ...this.parent?.(), backgroundColor, ...borders };
    },
});
