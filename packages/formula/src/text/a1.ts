// A1 labels: a column's letters, a cell's label and a rectangle's text, and the size of the grid a reference may
// name. The parser and the A1 printer build on these, and so does everything outside the engine that writes a cell
// label, such as a chart's range or a link.

// Excel's grid, A1 to XFD1048576. A label past it is a name, and a reference that resolves past it prints #REF!.
export const GRID_ROWS = 1048576;
export const GRID_COLUMNS = 16384;

// The column a label names, from 0, or -1 for text that names no column of the grid.
export function columnIndex(label: string): number {
    if (label.length === 0 || label.length > 3) return -1;
    let column = 0;
    for (let i = 0; i < label.length; i += 1) {
        const letter = (label.charCodeAt(i) | 32) - 96;
        if (letter < 1 || letter > 26) return -1;
        column = column * 26 + letter;
    }
    return column > GRID_COLUMNS ? -1 : column - 1;
}

export function columnLabel(column: number): string {
    let label = '';
    for (let rest = column; rest >= 0; rest = Math.floor(rest / 26) - 1) {
        label = String.fromCharCode(65 + (rest % 26)) + label;
    }
    return label;
}

export function toA1(row: number, column: number): string {
    return columnLabel(column) + (row + 1);
}

// A cell or a rectangle as A1 text, one cell without the colon; `absolute` is the $A$1 form.
export function rangeToA1(
    { row, column }: { readonly row: readonly number[]; readonly column: readonly number[] },
    absolute = false,
): string {
    const cell = (r: number, c: number) => (absolute ? `$${columnLabel(c)}$${r + 1}` : toA1(r, c));
    const start = cell(row[0], column[0]);
    return row[0] === row[1] && column[0] === column[1] ? start : `${start}:${cell(row[1], column[1])}`;
}
