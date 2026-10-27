// A table's column widths against the text column: the floor a column keeps and the one fit that shrinks a table wider
// than the column into it, so every renderer that must fit a table, such as the docx writer and the PDF, fits it alike.

// The narrowest a table column gets when a table is scaled to fit the text column.
export const MIN_TABLE_COLUMN_PX = 25;

// Widths in px fitted into a column `columnPx` wide: a table that fits keeps them, and a wider one shrinks every column
// by one factor, none below the floor. `total` is the whole table's width when `widths` are only some of its columns,
// such as one cell's.
export function fitColumnWidths(
    widths: number[],
    columnPx: number,
    total = widths.reduce((sum, width) => sum + width, 0),
): number[] {
    if (total <= columnPx) return widths;
    const scale = columnPx / total;
    return widths.map((width) => Math.max(MIN_TABLE_COLUMN_PX, Math.floor(width * scale)));
}
