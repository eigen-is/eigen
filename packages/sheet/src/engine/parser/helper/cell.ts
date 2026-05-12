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

// Empty string for negative indices.
export function rowIndexToLabel(row: number): string {
    return row >= 0 ? `${row + 1}` : '';
}

const COLUMN_LABEL_BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COLUMN_LABEL_BASE_LENGTH = COLUMN_LABEL_BASE.length;

// Base-26 decode, e.g. "A" → 0, "Z" → 25, "AA" → 26.
export function columnLabelToIndex(label: string): number {
    if (typeof label !== 'string') return -1;
    const upperLabel = label.toUpperCase();
    let result = 0;
    for (let i = 0, j = upperLabel.length - 1; i < upperLabel.length; i += 1, j -= 1) {
        result += COLUMN_LABEL_BASE_LENGTH ** j * (COLUMN_LABEL_BASE.indexOf(upperLabel[i]) + 1);
    }
    return result - 1;
}

// Base-26 encode, inverse of columnLabelToIndex.
export function columnIndexToLabel(column: number): string {
    let result = '';
    let n = column;
    while (n >= 0) {
        result = String.fromCharCode((n % COLUMN_LABEL_BASE_LENGTH) + 97) + result;
        n = Math.floor(n / COLUMN_LABEL_BASE_LENGTH) - 1;
    }
    return result.toUpperCase();
}

const simpleSheetName = '[A-Za-z0-9_\\u00C0-\\u02AF]+';
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
const LABEL_EXTRACT_REGEXP = new RegExp(`^(?:${sheetNameRegexp})?([$])?([A-Za-z]*)([$])?([0-9]*)$`);

// Split a cell label like `Sheet1!$A$1` into [row, column, sheetName]. Returns
// [null, null, null] when unparseable. Used by the parser to build cell refs.
export function extractLabel(label: string): [CellCoordinate | null, CellCoordinate | null, string | null] {
    if (typeof label !== 'string' || !LABEL_EXTRACT_REGEXP.test(label)) {
        return [null, null, null];
    }
    const match = label.toUpperCase().match(LABEL_EXTRACT_REGEXP);
    if (!match) return [null, null, null];
    const [, sheetNameStr, columnAbs, column, rowAbs, row] = match;
    if (column == null && row == null) return [null, null, null];
    const sheetName =
        sheetNameStr == null ? null : label.slice(0, sheetNameStr.length).replace(/^'|'$/g, '').replace(/''/g, "'");

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
