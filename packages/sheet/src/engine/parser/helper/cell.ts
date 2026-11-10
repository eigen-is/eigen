// Cell labels and sheet names as the formula parser reads them: a label's row and column, the two ways a reference
// may spell a sheet name, the key two names are compared by, and the sheet a name reads. The reference patterns of
// the engine build on these.

import {
    columnIndexToLabel,
    columnLabelToIndex,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
} from '@workspace/lib/sheets';

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

const PRINTABLE_ASCII = /^[ -~]*$/;

// What two sheet names are compared by. Each character folds to its uppercase on its own, so the Greek final ς
// matches σ, and one whose uppercase is longer keeps its case, so ß never matches ss. ASCII folds in one step.
export function sheetNameKey(name: string): string {
    if (PRINTABLE_ASCII.test(name)) return name.toUpperCase();
    let key = '';
    for (const char of name) {
        const upper = char.toUpperCase();
        key += upper.length === char.length ? upper : char;
    }
    return key;
}

// The sheet a name reads: the one of exactly that name, else one in another case. A workbook can still hold Data and
// data, from before the rename rule or a peer, and then each name keeps reading its own sheet.
export function findSheetByName<S extends { name: string }>(sheets: readonly S[], name: string): S | undefined {
    const exact = sheets.find((sheet) => sheet.name === name);
    if (exact) return exact;
    const key = sheetNameKey(name);
    // A key is as long as its name, so a name of another length never matches, and its key is never built.
    return sheets.find((sheet) => sheet.name.length === name.length && sheetNameKey(sheet.name) === key);
}

// The sheet each name reads, as findSheetByName reads it, through maps built once. A walk that reads many names, such
// as a recalc or a row insert over every formula, builds one, so a name no sheet holds costs no walk of the sheets.
export function sheetFinder<S extends { name: string }>(sheets: readonly S[]): (name: string) => S | undefined {
    const byName = new Map<string, S>();
    const byKey = new Map<string, S>();
    for (const sheet of sheets) {
        // The first wins, as in findSheetByName.
        if (!byName.has(sheet.name)) byName.set(sheet.name, sheet);
        const key = sheetNameKey(sheet.name);
        if (!byKey.has(key)) byKey.set(key, sheet);
    }
    return (name) => byName.get(name) ?? byKey.get(sheetNameKey(name));
}

// Inverse of unquoteSheetName: single-quote wrap with embedded quotes doubled.
export function quoteSheetName(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

const SIMPLE_NAME = new RegExp(`^${SIMPLE_SHEET_NAME}$`);
const MISREAD_BARE = /^\d|^[A-Z]{1,3}\d+$|^R\d|^R?C\d|^(?:R|C|RC|TRUE|FALSE)$/i;

// A name Excel would read as something else when bare: a number, an A1 or R1C1 cell, a boolean.
export function misreadBare(name: string): boolean {
    return MISREAD_BARE.test(name);
}

// The name as a ref's sheet prefix spells it: bare when Excel reads it as one, quoted otherwise, which is always legal.
export function sheetRefName(name: string): string {
    return SIMPLE_NAME.test(name) && !misreadBare(name) ? name : quoteSheetName(name);
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

// `$` and a missing axis (`A:A`, `1:1`) stay put; null means the copy left the grid (#REF!).
export function offsetCoordinate(
    coordinate: CellCoordinate,
    offset: number,
    axis: 'row' | 'column',
): CellCoordinate | null {
    if (offset === 0 || coordinate.isAbsolute || coordinate.index === -1) {
        return coordinate;
    }
    const index = coordinate.index + offset;
    if (index < 0 || index >= (axis === 'row' ? REFERENCE_ROW_COUNT : REFERENCE_COLUMN_COUNT)) {
        return null;
    }
    const label = axis === 'row' ? rowIndexToLabel(index) : columnIndexToLabel(index);
    return { index, label, isAbsolute: false };
}

type CellLeg = [row: CellCoordinate, column: CellCoordinate];

// Orders one axis of a range's two legs; a missing axis (`A:A` rows, `1:1` columns) stays as is.
export function sortLegs(start: CellCoordinate, end: CellCoordinate): [CellCoordinate, CellCoordinate] {
    return start.index !== -1 && end.index !== -1 && start.index > end.index ? [end, start] : [start, end];
}

// Both axes move at once and legs sort before and after, as in Excel (`A$3:A1` down 1 is `A2:A$3`).
export function offsetRange(
    start: CellLeg,
    end: CellLeg,
    rowOffset: number,
    colOffset: number,
): [CellLeg, CellLeg] | null {
    const [row0, row1] = sortLegs(start[0], end[0]);
    const [column0, column1] = sortLegs(start[1], end[1]);
    const startRow = offsetCoordinate(row0, rowOffset, 'row');
    const endRow = offsetCoordinate(row1, rowOffset, 'row');
    const startColumn = offsetCoordinate(column0, colOffset, 'column');
    const endColumn = offsetCoordinate(column1, colOffset, 'column');
    if (startRow == null || endRow == null || startColumn == null || endColumn == null) {
        return null;
    }
    const [rowStart, rowEnd] = sortLegs(startRow, endRow);
    const [colStart, colEnd] = sortLegs(startColumn, endColumn);
    return [
        [rowStart, colStart],
        [rowEnd, colEnd],
    ];
}
