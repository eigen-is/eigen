import { columnIndexToLabel, columnLabelToIndex } from '@workspace/lib/sheets';

export {
    extractLabel,
    quoteSheetName,
    rowIndexToLabel,
    rowLabelToIndex,
    sheetRefName,
    toLabel,
    unquoteSheetName,
} from './parser/helper/cell';

import { rowIndexToLabel, rowLabelToIndex, SHEET_NAME_PREFIX, unquoteSheetName } from './parser/helper/cell';

// Excel's limit on a sheet name's length and the characters it refuses in one; it refuses a quote at either end too.
export const MAX_SHEET_NAME_LENGTH = 31;
export const SHEET_NAME_FORBIDDEN = /[\\/?*[\]:]/g;

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

// A cell or a rectangle as A1 text, one cell without the colon; `absolute` is Excel's $A$1 form.
export function rangeToA1(
    { row, column }: { row: readonly number[]; column: readonly number[] },
    absolute = false,
): string {
    const cell = (r: number, c: number) => (absolute ? `$${columnIndexToLabel(c)}$${rowIndexToLabel(r)}` : toA1(r, c));
    const start = cell(row[0], column[0]);
    return row[0] === row[1] && column[0] === column[1] ? start : `${start}:${cell(row[1], column[1])}`;
}
