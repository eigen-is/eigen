export type CellCoordinate = {
    index: number;
    label: string;
    isAbsolute: boolean;
};

// Returns -1 for unrecognized labels, 0-based row index otherwise.
export function rowLabelToIndex(label: string): number {
    const result = parseInt(label, 10);
    if (Number.isNaN(result)) return -1;
    return Math.max(result - 1, -1);
}

export function rowIndexToLabel(row: number): string {
    return row >= 0 ? `${row + 1}` : '';
}

const COLUMN_LABEL_BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COLUMN_LABEL_BASE_LENGTH = COLUMN_LABEL_BASE.length;

// Base-26 decode, e.g. "A" → 0, "Z" → 25, "AA" → 26.
export function columnLabelToIndex(label: string): number {
    const upperLabel = label.toUpperCase();
    let result = 0;
    for (let i = 0, j = upperLabel.length - 1; i < upperLabel.length; i += 1, j -= 1) {
        result += COLUMN_LABEL_BASE_LENGTH ** j * (COLUMN_LABEL_BASE.indexOf(upperLabel[i]) + 1);
    }
    return result - 1;
}

export function columnIndexToLabel(column: number): string {
    let result = '';
    let n = column;
    while (n >= 0) {
        result = COLUMN_LABEL_BASE[n % COLUMN_LABEL_BASE_LENGTH] + result;
        n = Math.floor(n / COLUMN_LABEL_BASE_LENGTH) - 1;
    }
    return result;
}

// The two sheet-name spellings a reference may carry (`Sheet1!A1`, `'My Sheet'!A1`); every
// reference regex in the engine composes from these.
export const SIMPLE_SHEET_NAME = '[A-Za-z0-9_\\u00C0-\\u02AF]+';
export const QUOTED_SHEET_NAME = "'(?:(?!').|'')*'";
export const SHEET_NAME_PREFIX = `(${SIMPLE_SHEET_NAME}|${QUOTED_SHEET_NAME})!`;
// The column group is optional as a whole so the `$` of a row-only leg (`$1`) binds to the row.
const LABEL_EXTRACT_REGEXP = new RegExp(`^(?:${SHEET_NAME_PREFIX})?(?:([$])?([A-Za-z]+))?([$])?([0-9]*)$`);

export function unquoteSheetName(raw: string): string {
    return raw.replace(/^'|'$/g, '').replace(/''/g, "'");
}

// Inverse of unquoteSheetName: single-quote wrap with embedded quotes doubled.
export function quoteSheetName(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

// Split a cell label like `Sheet1!$A$1` into [row, column, sheetName], null when
// unparseable. Used by the parser to build cell refs.
export function extractLabel(label: string): [CellCoordinate, CellCoordinate, string | null] | null {
    const match = label.toUpperCase().match(LABEL_EXTRACT_REGEXP);
    if (!match) return null;

    const [, sheetNameStr, columnAbs, column = '', rowAbs, row] = match;
    const sheetName = sheetNameStr == null ? null : unquoteSheetName(label.slice(0, sheetNameStr.length));

    return [
        { index: rowLabelToIndex(row), label: row, isAbsolute: rowAbs === '$' },
        { index: columnLabelToIndex(column), label: column, isAbsolute: columnAbs === '$' },
        sheetName,
    ];
}

export function toLabel(row: CellCoordinate, column: CellCoordinate): string {
    const rowLabel = (row.isAbsolute ? '$' : '') + rowIndexToLabel(row.index);
    const columnLabel = (column.isAbsolute ? '$' : '') + columnIndexToLabel(column.index);
    return columnLabel + rowLabel;
}

// `$` and a missing axis (`A:A`, `1:1`) stay put; null means the copy left the sheet (#REF!).
export function offsetCoordinate(
    coordinate: CellCoordinate,
    offset: number,
    indexToLabel: (index: number) => string,
): CellCoordinate | null {
    if (offset === 0 || coordinate.isAbsolute || coordinate.index === -1) {
        return coordinate;
    }
    const index = coordinate.index + offset;
    if (index < 0) {
        return null;
    }
    return { index, label: indexToLabel(index), isAbsolute: false };
}

export type CellLeg = [row: CellCoordinate, column: CellCoordinate];

function isReversed(start: CellCoordinate, end: CellCoordinate): boolean {
    return start.index !== -1 && end.index !== -1 && start.index > end.index;
}

function sortLegs(start: CellCoordinate, end: CellCoordinate): [CellCoordinate, CellCoordinate] {
    return isReversed(start, end) ? [end, start] : [start, end];
}

// Both axes move at once and crossed legs re-sort, as in Excel (`A1:$B$2` by (2,3) is `$B$2:D3`); a reversed range stays put.
export function offsetRange(
    start: CellLeg,
    end: CellLeg,
    rowOffset: number,
    colOffset: number,
): [CellLeg, CellLeg] | null {
    let [startRow, startColumn]: (CellCoordinate | null)[] = start;
    let [endRow, endColumn]: (CellCoordinate | null)[] = end;
    if (!isReversed(startRow, endRow) && !isReversed(startColumn, endColumn)) {
        startRow = offsetCoordinate(startRow, rowOffset, rowIndexToLabel);
        endRow = offsetCoordinate(endRow, rowOffset, rowIndexToLabel);
        startColumn = offsetCoordinate(startColumn, colOffset, columnIndexToLabel);
        endColumn = offsetCoordinate(endColumn, colOffset, columnIndexToLabel);
        if (startRow == null || endRow == null || startColumn == null || endColumn == null) {
            return null;
        }
    }
    const [rowStart, rowEnd] = sortLegs(startRow, endRow);
    const [colStart, colEnd] = sortLegs(startColumn, endColumn);
    return [
        [rowStart, colStart],
        [rowEnd, colEnd],
    ];
}
