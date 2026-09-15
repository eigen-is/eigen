export {
    columnIndexToLabel,
    columnLabelToIndex,
    extractLabel,
    quoteSheetName,
    rowIndexToLabel,
    rowLabelToIndex,
    toLabel,
    unquoteSheetName,
} from './parser/helper/cell';

import {
    columnIndexToLabel,
    columnLabelToIndex,
    rowIndexToLabel,
    rowLabelToIndex,
    SHEET_NAME_PREFIX,
    unquoteSheetName,
} from './parser/helper/cell';

export type CellRef = { col: number; row: number };

export type A1Range = {
    sheet?: string;
    start: CellRef;
    end: CellRef;
};

const RANGE_REGEXP = new RegExp(
    `^(?:${SHEET_NAME_PREFIX})?([$])?([A-Za-z]+)([$])?([0-9]+)(?::([$])?([A-Za-z]+)([$])?([0-9]+))?$`,
);

export function parseA1Range(range: string): A1Range | null {
    const match = range.match(RANGE_REGEXP);
    if (!match) return null;

    const [, sheetRaw, , startCol, , startRow, , endCol, , endRow] = match;

    const startColIndex = columnLabelToIndex(startCol);
    const startRowIndex = rowLabelToIndex(startRow);
    if (startColIndex < 0 || startRowIndex < 0) return null;

    const sheet = sheetRaw == null ? undefined : unquoteSheetName(sheetRaw);
    const start: CellRef = { col: startColIndex, row: startRowIndex };

    if (endCol == null || endRow == null) {
        return { sheet, start, end: { ...start } };
    }

    const endColIndex = columnLabelToIndex(endCol);
    const endRowIndex = rowLabelToIndex(endRow);
    if (endColIndex < 0 || endRowIndex < 0) return null;

    return { sheet, start, end: { col: endColIndex, row: endRowIndex } };
}

export function toA1(row: number, col: number): string {
    return columnIndexToLabel(col) + rowIndexToLabel(row);
}
