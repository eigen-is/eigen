// Pure utility functions for formula parsing and evaluation.
// Zero dependencies on Context or any state module.
import { columnLabelToIndex } from './a1-notation';

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

    const rangetxtArr = rangetxt.split(':');

    const row: number[] = [];
    const col: number[] = [];
    row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ''), 10) - 1;
    row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ''), 10) - 1;
    if (row[0] > row[1]) {
        return false;
    }

    col[0] = columnLabelToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ''));
    col[1] = columnLabelToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ''));
    if (col[0] > col[1]) {
        return false;
    }

    return reg_cellRange.test(rangetxtArr[0]) && reg_cellRange.test(rangetxtArr[1]);
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
