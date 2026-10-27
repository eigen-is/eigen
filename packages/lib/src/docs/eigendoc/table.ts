// A table's column widths against the text column: the floor a column keeps and the one fit that shrinks a table wider
// than the column into it, so every renderer that must fit a table, such as the docx writer and the PDF, fits it alike.

// The narrowest a table column gets when a table is scaled to fit the text column.
export const MIN_TABLE_COLUMN_PX = 25;

// The fit of a table `total` px wide into a column `columnPx` wide, as a function of one column's width: a table that
// fits keeps its widths, and a wider one shrinks every column by one factor, none below the floor. A renderer that
// meets the table cell by cell, such as the PDF's, takes the factor once for every cell.
export function columnFit(columnPx: number, total: number): (width: number) => number {
    if (total <= columnPx) return (width) => width;
    const scale = columnPx / total;
    return (width) => Math.max(MIN_TABLE_COLUMN_PX, Math.floor(width * scale));
}

// A whole table's widths in px fitted into a column `columnPx` wide, by `columnFit`.
export function fitColumnWidths(widths: number[], columnPx: number): number[] {
    const total = widths.reduce((sum, width) => sum + width, 0);
    return total <= columnPx ? widths : widths.map(columnFit(columnPx, total));
}
