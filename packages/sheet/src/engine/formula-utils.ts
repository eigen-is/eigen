// Plain helpers for reading formula text, shared by the editor and the server's recalc: the operators a text walker
// stops at, whether a string is a cell reference, and the cells a reference covers. The dependency walk, the formula
// editor and the reference shifts build on them, for example. Nothing here reads the workbook context.

import type { CellMatrix, Sheet } from '@workspace/lib/sheets';
import { columnLabelToIndex } from '@workspace/lib/sheets';
import { SHEET_NAME_PREFIX, unquoteSheetName } from './parser/helper/cell';
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
    const val = txt.split('!');
    const rangetxt = val.length > 1 ? val[1] : val[0];
    if (rangetxt.indexOf(':') === -1) {
        return CELL.test(rangetxt);
    }
    // A reversed range (`A$3:A1`) is a ref too: Excel reads it as its sorted twin.
    const rangetxtArr = rangetxt.split(':');
    return RANGE_END.test(rangetxtArr[0]) && RANGE_END.test(rangetxtArr[1]);
}

// The cells a reference covers, or null when it is none or names a sheet that isn't there. `data` is the matrix of
// sheet `formulaId`. A whole column or row ends where its sheet's matrix ends. The answer is kept in
// `cellTextToIndexList`: by the reference's text when it names a sheet, by `${text}_${formulaId}` when it doesn't.
export function resolveCellRange(
    sheets: readonly Pick<Sheet, 'id' | 'name' | 'data'>[],
    cellTextToIndexList: Record<string, FormulaDependency>,
    txt: string,
    formulaId: string,
    data: CellMatrix | null | undefined,
): FormulaDependency | null {
    if (txt.length === 0) {
        return null;
    }
    const namesSheet = txt.indexOf('!') > -1;
    const key = namesSheet ? txt : `${txt}_${formulaId}`;
    if (key in cellTextToIndexList) {
        return cellTextToIndexList[key];
    }

    let rangetxt = txt;
    let sheetId: string | undefined = formulaId;
    let sheetdata = data;
    if (namesSheet) {
        const matchRes = txt.match(SHEET_REFERENCE);
        if (matchRes == null) {
            return null;
        }
        const [, sheettxt1, starttxt1, sheettxt2, starttxt2] = matchRes;
        if (sheettxt2 != null && sheettxt1 !== sheettxt2) {
            return null;
        }
        rangetxt = starttxt2 ? `${starttxt1}:${starttxt2}` : starttxt1;
        const sheet = sheets.find((s) => s.name === unquoteSheetName(sheettxt1));
        sheetId = sheet?.id;
        sheetdata = sheet?.data;
    } else if (!sheets.some((s) => s.id === formulaId)) {
        return null;
    }

    if (sheetdata == null) {
        return null;
    }

    if (rangetxt.indexOf(':') === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
        const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

        if (!Number.isNaN(row) && !Number.isNaN(col)) {
            const item: FormulaDependency = { row: [row, row], column: [col, col], sheetId };
            cellTextToIndexList[key] = item;
            return item;
        }
        return null;
    }

    // A sheet with no rows has no width either, so a whole row or column on it reads nothing.
    if (sheetdata.length === 0) {
        return null;
    }

    const rangetxtArr = rangetxt.split(':');
    const row: [number, number] = [-1, -1];
    const col: [number, number] = [-1, -1];
    row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ''), 10) - 1;
    row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ''), 10) - 1;
    if (Number.isNaN(row[0])) {
        row[0] = 0;
    }
    if (Number.isNaN(row[1])) {
        row[1] = sheetdata.length - 1;
    }
    if (row[0] > row[1]) {
        row.reverse();
    }
    col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ''));
    col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ''));
    if (Number.isNaN(col[0])) {
        col[0] = 0;
    }
    if (Number.isNaN(col[1])) {
        col[1] = sheetdata[0].length - 1;
    }
    if (col[0] > col[1]) {
        col.reverse();
    }

    const item: FormulaDependency = { row, column: col, sheetId };
    cellTextToIndexList[key] = item;
    return item;
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

// NaN, not columnLabelToIndex's -1, marks a missing column, which resolveCellRange reads as a whole row.
function columnCharToIndex(letters: string): number {
    return letters.length === 0 ? NaN : columnLabelToIndex(letters);
}
