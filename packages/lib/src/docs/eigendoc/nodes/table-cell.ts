import { TableCell, TableHeader } from '@tiptap/extension-table';

const HEX_COLOR = /^#[0-9a-f]{6}$/;
// A browser spells a style's color as rgb(), whatever the HTML wrote.
const RGB_COLOR = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/;

// A cell's fill as stored: a peer or a paste writes any value, and it lands in a style and a docx's w:shd.
export function readCellBackground(value: unknown): string | null {
    const color = typeof value === 'string' ? value.toLowerCase() : '';
    return HEX_COLOR.test(color) ? color : null;
}

function parseCellBackground(element: HTMLElement): string | null {
    const color = element.style.backgroundColor;
    const rgb = RGB_COLOR.exec(color);
    if (!rgb) return readCellBackground(color);
    return readCellBackground(
        `#${rgb
            .slice(1)
            .map((channel) => Number(channel).toString(16).padStart(2, '0'))
            .join('')}`,
    );
}

const backgroundColor = {
    default: null,
    parseHTML: parseCellBackground,
    renderHTML: (attributes: Record<string, unknown>) => {
        const color = readCellBackground(attributes['backgroundColor']);
        return color ? { style: `background-color: ${color}` } : {};
    },
};

export const EigenTableCell = TableCell.extend({
    addAttributes() {
        return { ...this.parent?.(), backgroundColor };
    },
});

export const EigenTableHeader = TableHeader.extend({
    addAttributes() {
        return { ...this.parent?.(), backgroundColor };
    },
});
