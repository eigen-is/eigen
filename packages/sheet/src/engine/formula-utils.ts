// Pure utility functions for formula parsing and evaluation.
// Zero dependencies on Context or any state module.
import type { CellMatrix, Sheet } from '@workspace/lib/sheets';
import { columnLabelToIndex } from './a1-notation';
import { SHEET_NAME_PREFIX } from './parser/helper/cell';
import type { FormulaDependency } from './types';

export const operatorPriority: Readonly<Record<string, number>> = {
    '^': 0,
    '%': 1,
    '*': 1,
    '/': 1,
    '+': 2,
    '-': 2,
};

const operatorArr = '==|!=|<>|<=|>=|=|+|-|>|<|/|*|%|&|^'.split('|');

export const operatorjson: Readonly<Record<string, number>> = (() => {
    const map: Record<string, number> = {};
    for (let i = 0; i < operatorArr.length; i += 1) {
        map[operatorArr[i]] = 1;
    }
    return map;
})();

// Handles single cells (A1, $A$1), ranges (A1:B3), column-only ranges (A:C),
// and sheet-qualified references (Sheet1!A1).
export function iscelldata(txt: string) {
    const val = txt.split('!');
    let rangetxt: string;

    if (val.length > 1) {
        [, rangetxt] = val;
    } else {
        [rangetxt] = val;
    }

    const reg_cell = /^(([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+))$/;

    if (rangetxt.indexOf(':') === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
        const col = columnLabelToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

        return !Number.isNaN(row) && col >= 0 && reg_cell.test(rangetxt);
    }

    const reg_cellRange =
        /^(((([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+)))|((([a-zA-Z]+)|([$][a-zA-Z]+)))|((([0-9]+)|([$][0-9]+))))$/;

    // A reversed range (`A$3:A1`) is a ref too: Excel reads it as its sorted twin.
    const rangetxtArr = rangetxt.split(':');
    return reg_cellRange.test(rangetxtArr[0]) && reg_cellRange.test(rangetxtArr[1]);
}

// NaN, not columnLabelToIndex's -1, marks a missing column: the range parser reads it as a whole row.
function columnCharToIndex(a: string): number {
    if (a.length === 0) {
        return NaN;
    }
    const str = a.toLowerCase().split('');
    const al = str.length;
    let numout = 0;
    for (let i = 0; i < al; i += 1) {
        const charnum = str[i].charCodeAt(0) - 96;
        numout += charnum * 26 ** (al - i - 1);
    }
    if (numout === 0) {
        return NaN;
    }
    return numout - 1;
}

const rowColumnRegexp = '[$]?[A-Za-z]+[$]?[0-9]+';
const rowColumnWithSheetName = `(?:${SHEET_NAME_PREFIX})?(${rowColumnRegexp})`;
const LABEL_EXTRACT_REGEXP = new RegExp(`^${rowColumnWithSheetName}(?:[:]${rowColumnWithSheetName})?$`);

function addToCellIndexList(
    cellTextToIndexList: Record<string, FormulaDependency>,
    txt: string,
    infoObj: FormulaDependency,
): void {
    if (txt.indexOf('!') > -1) {
        cellTextToIndexList[txt.replace(/\\'/g, "'").replace(/''/g, "'")] = infoObj;
    } else {
        cellTextToIndexList[`${txt}_${infoObj.sheetId}`] = infoObj;
    }
}

// `data` is sheet `formulaId`'s matrix, which bounds a whole-row or whole-column range.
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

    let rangetxt = '';
    let sheetId: string | undefined;
    let sheetdata: CellMatrix | null | undefined = null;

    if (txt.indexOf('!') > -1) {
        if (txt in cellTextToIndexList) {
            return cellTextToIndexList[txt];
        }

        const matchRes = txt.match(LABEL_EXTRACT_REGEXP);
        if (matchRes == null) {
            return null;
        }
        const [, sheettxt1, starttxt1, sheettxt2, starttxt2] = matchRes;
        if (sheettxt2 != null && sheettxt1 !== sheettxt2) {
            return null;
        }
        rangetxt = starttxt2 ? `${starttxt1}:${starttxt2}` : starttxt1;
        const sheettxt = sheettxt1.replace(/^'|'$/g, '').replace(/\\'/g, "'").replace(/''/g, "'");
        const sheet = sheets.find((s) => s.name === sheettxt);
        sheetId = sheet?.id;
        sheetdata = sheet?.data;
    } else {
        if (`${txt}_${formulaId}` in cellTextToIndexList) {
            return cellTextToIndexList[`${txt}_${formulaId}`];
        }
        if (!sheets.some((s) => s.id === formulaId)) {
            return null;
        }
        sheetId = formulaId;
        sheetdata = data;
        rangetxt = txt;
    }

    if (sheetdata == null) {
        return null;
    }

    if (rangetxt.indexOf(':') === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ''), 10) - 1;
        const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ''));

        if (!Number.isNaN(row) && !Number.isNaN(col)) {
            const item: FormulaDependency = { row: [row, row], column: [col, col], sheetId };
            addToCellIndexList(cellTextToIndexList, txt, item);
            return item;
        }
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
    addToCellIndexList(cellTextToIndexList, txt, item);
    return item;
}

// Evaluates a reversed-postfix expression stack, wrapping each operator
// application in a luckysheet_compareWith(...) call.
export function calPostfixExpression(cal: string[]): string {
    if (cal.length === 0) {
        return '';
    }
    const stack: string[] = [];
    for (let i = cal.length - 1; i >= 0; i -= 1) {
        const c = cal[i];
        if (c in operatorjson) {
            const s2 = stack.pop();
            const s1 = stack.pop();
            const str = `luckysheet_compareWith(${s1},'${c}', ${s2})`;
            stack.push(str);
        } else {
            stack.push(c);
        }
    }

    if (stack.length > 0) {
        return stack[0];
    }

    return '';
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
