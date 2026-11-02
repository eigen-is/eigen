// A doc's table cells: TipTap's cell and header with the look a cell keeps of its own, its fill and its four border
// sides. The editor and every server renderer draw a cell through these nodes, and the docx reader and writer store
// and read the same attributes. A peer or a paste can write any value, so every reader of an attribute goes through
// readHexColor or readBorder, which keep only the stored form.

import { TableCell, TableHeader } from '@tiptap/extension-table';
import { parseRgb, readHexColor } from '../../../constants/colors';
import { BORDER_STYLES, borderValue, MAX_BORDER_PX, MIN_BORDER_PX, readBorder } from './border';

// Each side's attribute, in CSS's clockwise order.
export const CELL_BORDER_SIDES = [
    ['borderTop', 'top'],
    ['borderRight', 'right'],
    ['borderBottom', 'bottom'],
    ['borderLeft', 'left'],
] as const;
export type CellBorderAttribute = (typeof CELL_BORDER_SIDES)[number][0];
export type CellSide = (typeof CELL_BORDER_SIDES)[number][1];

// A browser spells a style's color as rgb(), whatever the HTML wrote. A see-through one is no color: a cell has no
// alpha, and its rgb() alone would paint it opaque.
function hexOf(color: string): string | null {
    const rgb = parseRgb(color);
    if (!rgb) return readHexColor(color);
    return rgb.alpha === 1 ? rgb.hex : null;
}

// A pasted side, Google Docs' in points: one 0 wide, or of style none or hidden, draws none.
function parseCellBorder(element: HTMLElement, side: string): string | null {
    const style = element.style.getPropertyValue(`border-${side}-style`);
    const width = /^(\d*\.?\d+)(px|pt)$/.exec(element.style.getPropertyValue(`border-${side}-width`));
    if (style === 'none' || style === 'hidden' || (width && Number(width[1]) === 0)) return 'none';
    const color = hexOf(element.style.getPropertyValue(`border-${side}-color`));
    if (!width || !color || !BORDER_STYLES.some((known) => known === style)) return null;
    const px = Number(width[1]) * (width[2] === 'pt' ? 4 / 3 : 1);
    const border = readBorder(
        `${Number(Math.min(Math.max(px, MIN_BORDER_PX), MAX_BORDER_PX).toFixed(2))}px ${style} ${color}`,
    );
    return border && borderValue(border);
}

const backgroundColor = {
    default: null,
    parseHTML: (element: HTMLElement) => hexOf(element.style.backgroundColor),
    renderHTML: (attributes: Record<string, unknown>) => {
        const color = readHexColor(attributes['backgroundColor']);
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
                const border = readBorder(attributes[name]);
                return border ? { style: `border-${side}: ${borderValue(border)}` } : {};
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
