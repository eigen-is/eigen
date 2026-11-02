// Plain helpers for reading formula text, shared by the editor and the server's recalc: the operators a text walker
// stops at, whether a string is a cell reference, and the cells a reference covers. The dependency walk, the formula
// editor and the reference shifts build on them, for example. Nothing here reads the workbook context.

import type { CellMatrix, Sheet } from '@workspace/lib/sheets';
import { columnLabelToIndex } from '@workspace/lib/sheets';
import { findSheetByName, SHEET_NAME_PREFIX, unquoteSheetName } from './parser/helper/cell';
import type { FormulaDependency } from './types';

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
    const parts = txt.split('!');
    const cells = parts.length > 1 ? parts[1] : parts[0];
    if (!cells.includes(':')) return CELL.test(cells);
    // A reversed range (`A$3:A1`) is a ref too: Excel reads it as its sorted twin.
    const [start, end] = cells.split(':');
    return RANGE_END.test(start) && RANGE_END.test(end);
}

// The cells a reference covers, or null when it is none or names a sheet that isn't there. `data` is the matrix of
// sheet `formulaSheetId`. A whole column or row ends where its sheet's matrix ends. The answer is kept in
// `cellTextToIndexList`: by the reference's text when it names a sheet, by `${reference}_${formulaSheetId}` when it
// doesn't.
export function resolveCellRange(
    sheets: readonly Pick<Sheet, 'id' | 'name' | 'data'>[],
    cellTextToIndexList: Record<string, FormulaDependency>,
    reference: string,
    formulaSheetId: string,
    data: CellMatrix | null | undefined,
): FormulaDependency | null {
    if (reference.length === 0) return null;
    const namesSheet = reference.includes('!');
    const key = namesSheet ? reference : `${reference}_${formulaSheetId}`;
    if (key in cellTextToIndexList) return cellTextToIndexList[key];

    let cells = reference;
    let sheetId: string | undefined = formulaSheetId;
    let matrix = data;
    if (namesSheet) {
        const match = reference.match(SHEET_REFERENCE);
        if (match == null) return null;
        const [, startSheet, start, endSheet, end] = match;
        // A1:Data!B2 names a sheet on its end only, which the engine can't read as a range.
        if (startSheet == null) return null;
        const sheet = findSheetByName(sheets, unquoteSheetName(startSheet));
        // The engine reads Data!A1:'Data'!B2 as one sheet's range, so only the sheets the names read count.
        if (endSheet != null && findSheetByName(sheets, unquoteSheetName(endSheet)) !== sheet) return null;
        cells = end ? `${start}:${end}` : start;
        sheetId = sheet?.id;
        matrix = sheet?.data;
    } else if (!sheets.some((s) => s.id === formulaSheetId)) {
        return null;
    }
    if (matrix == null) return null;

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
    if (Number.isNaN(row[0])) row[0] = 0;
    if (Number.isNaN(col[0])) col[0] = 0;
    // A whole column ends at the sheet's last row, and on a sheet with no rows it reads nothing.
    if (Number.isNaN(row[1])) {
        if (matrix.length === 0) return null;
        row[1] = matrix.length - 1;
    }
    // A whole row ends at the sheet's last column, and on a sheet with no columns it reads nothing.
    if (Number.isNaN(col[1])) {
        const width = matrixWidth(matrix);
        if (width === 0) return null;
        col[1] = width - 1;
    }
    // A reversed range (B3:A1) reads as its sorted twin.
    const item: FormulaDependency = { row: sorted(row), column: sorted(col), sheetId };
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
