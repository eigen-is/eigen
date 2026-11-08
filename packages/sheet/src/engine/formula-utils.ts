// Plain helpers for reading formula text, shared by the editor and the server's recalc: the operators a text walker
// stops at, whether a string is a cell reference, and the cells a reference covers. The dependency walk, the formula
// editor and the reference shifts build on them, for example. Nothing here reads the workbook context.

import type { CellMatrix, Sheet } from '@workspace/lib/sheets';
import { columnLabelToIndex, REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { SHEET_NAME_PREFIX, unquoteSheetName } from './parser/helper/cell';
import type { FormulaDependency } from './types';

// Where a whole column or row ends: Excel's last row and column, whatever a sheet holds today, so growing a grid moves
// no reference. A reader of cells stops at its sheet's own end.
export const LAST_ROW = REFERENCE_ROW_COUNT - 1;
export const LAST_COLUMN = REFERENCE_COLUMN_COUNT - 1;

// The operators a formula's text walkers stop at. A two-character one is matched before its first character.
export const formulaOperators: ReadonlySet<string> = new Set([
    '<>',
    '<=',
    '>=',
    '=',
    '+',
    '-',
    '>',
    '<',
    '/',
    '*',
    '%',
    '&',
    '^',
]);

// One end of a reference: a cell, a whole column or a whole row, each part with an optional `$`.
const REFERENCE_END = '[$]?[A-Za-z]+[$]?[0-9]+|[$]?[A-Za-z]+|[$]?[0-9]+';
const CELL = /^[$]?[A-Za-z]+[$]?[0-9]+$/;
const RANGE_END = new RegExp(`^(?:${REFERENCE_END})$`);
// A reference that names its sheet, and may name it again after the colon.
const SHEET_REFERENCE = new RegExp(
    `^(?:${SHEET_NAME_PREFIX})?(${REFERENCE_END})(?::(?:${SHEET_NAME_PREFIX})?(${REFERENCE_END}))?$`,
);

// True for a cell (A1, $A$1), a range (A1:B3) and a whole column or row (A:C, 1:2), on the formula's sheet or on
// another (Sheet1!A1).
export function iscelldata(txt: string): boolean {
    // A quoted sheet name may hold a `!`, and the cells follow the last.
    const cells = txt.slice(txt.lastIndexOf('!') + 1);
    if (!cells.includes(':')) return CELL.test(cells);
    // A reversed range (`A$3:A1`) is a ref too: Excel reads it as its sorted twin.
    const [start, end] = cells.split(':');
    return RANGE_END.test(start) && RANGE_END.test(end);
}

// What resolving a reference reads: the sheet each name reads, and the references resolved so far.
// A walk over many formulas builds one, so the name lookup and the cache serve every formula.
export type WalkContext = {
    findSheet: (name: string) => Pick<Sheet, 'id'> | undefined;
    cellTextToIndexList: Record<string, FormulaDependency>;
};

// The cells a reference covers, or null when it is none or names a sheet that isn't there. An end with no row or
// column spans them all. Kept in `cellTextToIndexList` by its text, or `${reference}_${formulaSheetId}` with no sheet.
export function resolveCellRange(
    { findSheet, cellTextToIndexList }: WalkContext,
    reference: string,
    formulaSheetId: string,
): FormulaDependency | null {
    const namesSheet = reference.includes('!');
    const key = namesSheet ? reference : `${reference}_${formulaSheetId}`;
    if (key in cellTextToIndexList) return cellTextToIndexList[key];

    let cells = reference;
    let sheetId: string | undefined = formulaSheetId;
    if (namesSheet) {
        const match = reference.match(SHEET_REFERENCE);
        if (match == null) return null;
        const [, startSheet, start, endSheet, end] = match;
        // A1:Data!B2 names a sheet on its end only, which the engine can't read as a range.
        if (startSheet == null) return null;
        const sheet = findSheet(unquoteSheetName(startSheet));
        if (sheet == null) return null;
        // The engine reads Data!A1:'Data'!B2 as one sheet's range, so only the sheets the names read count.
        if (endSheet != null && findSheet(unquoteSheetName(endSheet)) !== sheet) return null;
        cells = end ? `${start}:${end}` : start;
        sheetId = sheet.id;
    }

    if (!cells.includes(':')) {
        const row = rowIndexOf(cells);
        const col = columnIndexOf(cells);
        if (Number.isNaN(row) || Number.isNaN(col)) return null;
        const item: FormulaDependency = { row: [row, row], column: [col, col], sheetId };
        cellTextToIndexList[key] = item;
        return item;
    }

    const [start, end] = cells.split(':');
    const row: [number, number] = [rowIndexOf(start), rowIndexOf(end)];
    const col: [number, number] = [columnIndexOf(start), columnIndexOf(end)];
    const everyRow = row.some(Number.isNaN);
    const everyColumn = col.some(Number.isNaN);
    if (everyRow && everyColumn) return null;
    // A reversed range (B3:A1) reads as its sorted twin.
    const item: FormulaDependency = {
        row: everyRow ? [0, LAST_ROW] : sorted(row),
        column: everyColumn ? [0, LAST_COLUMN] : sorted(col),
        sheetId,
    };
    cellTextToIndexList[key] = item;
    return item;
}

// The number of columns a sheet's matrix holds: its widest row's, as a stored sheet's matrix may lack rows, even its
// first.
export function matrixWidth(matrix: CellMatrix): number {
    let width = 0;
    for (const row of matrix) width = Math.max(width, row?.length ?? 0);
    return width;
}

// Checks parentheses are balanced, ignoring brackets inside quoted strings.
export function checkBracketNum(fp: string): boolean {
    let left = fp.match(/\(/g)?.length ?? 0;
    let right = fp.match(/\)/g)?.length ?? 0;

    for (const quoted of fp.match(/(['"])(?:(?!\1).)*?\1/g) ?? []) {
        left -= quoted.match(/\(/g)?.length ?? 0;
        right -= quoted.match(/\)/g)?.length ?? 0;
    }

    return left === right;
}

// The row of one end of a reference, from 0, or NaN for a whole column (A in A:C).
function rowIndexOf(end: string): number {
    return parseInt(end.replace(/[^0-9]/g, ''), 10) - 1;
}

// The column of one end of a reference, from 0, or NaN for a whole row (1 in 1:3). NaN, not columnLabelToIndex's
// -1, so resolveCellRange tells a missing column from a real one.
function columnIndexOf(end: string): number {
    const letters = end.replace(/[^A-Za-z]/g, '');
    return letters.length === 0 ? NaN : columnLabelToIndex(letters);
}

function sorted([a, b]: [number, number]): [number, number] {
    return a > b ? [b, a] : [a, b];
}
