// Plain helpers for reading formula text, shared by the editor and the server's recalc: operator priorities, whether
// a string is a cell reference, resolving a reference to a range, and the walker that finds the ranges an INDIRECT,
// OFFSET or INDEX call reads. Nothing here reads the workbook context.

import type { CellMatrix, Sheet } from '@workspace/lib/sheets';
import { columnLabelToIndex } from '@workspace/lib/sheets';
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

// Rewrites a formula into the old luckysheet_* call form and, on the way, hands each range argument of an INDIRECT,
// OFFSET or INDEX call to cellRangeFunction. The dependency graph needs those ranges, in the editor and on the
// server. The rewritten string only feeds the recursion.
export function isFunctionRange(txt: string, cellRangeFunction: (str: string) => void): string {
    if (txt.substring(0, 1) === '=') {
        txt = txt.substring(1);
    }

    const funcstack = txt.split('');
    let i = 0;
    let str = '';
    let function_str = '';

    const matchConfig = {
        bracket: 0,
        comma: 0,
        squote: 0,
        dquote: 0,
        compare: 0,
        braces: 0,
    };

    // bracket: 0 = operator bracket, 1 = function bracket
    const cal1: string[] = [];
    const cal2: string[] = [];
    const bracket: number[] = [];
    while (i < funcstack.length) {
        const s = funcstack[i];

        if (s === '(' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            if (str.length > 0 && bracket.length === 0) {
                str = str.toUpperCase();
                if (str.indexOf(':') > -1) {
                    const funcArray = str.split(':');
                    function_str += `luckysheet_getSpecialReference(true,'${funcArray[0]
                        .trim()
                        .replace(/'/g, "\\'")}', luckysheet_function.${funcArray[1]}.f(#lucky#`;
                } else {
                    function_str += `luckysheet_function.${str}.f(`;
                }
                bracket.push(1);
                str = '';
            } else if (bracket.length === 0) {
                function_str += '(';
                bracket.push(0);
                str = '';
            } else {
                bracket.push(0);
                str += s;
            }
        } else if (s === ')' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            bracket.pop();

            if (bracket.length === 0) {
                let functionS = isFunctionRange(str, cellRangeFunction);
                if (functionS.indexOf('#lucky#') > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, '')})`;
                }
                function_str += `${functionS})`;
                str = '';
            } else {
                str += s;
            }
        } else if (s === '{' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '{';
            matchConfig.braces += 1;
        } else if (s === '}' && matchConfig.squote === 0 && matchConfig.dquote === 0) {
            str += '}';
            matchConfig.braces -= 1;
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                // If "" is found, it represents an escaped quote character "
                if (i < funcstack.length - 1 && funcstack[i + 1] === '"') {
                    i += 1;
                    str += '\x7F'; // Replace "" with DEL character
                } else {
                    matchConfig.dquote -= 1;
                    str += '"';
                }
            } else {
                matchConfig.dquote += 1;
                str += '"';
            }
        } else if (s === "'" && matchConfig.dquote === 0) {
            str += "'";

            if (matchConfig.squote > 0) {
                // If '' is found, it represents an escaped single quote character '
                if (i < funcstack.length - 1 && funcstack[i + 1] === "'") {
                    i += 1;
                    str += "'";
                } else {
                    // If the next character is not ', the single-quoted string is ended
                    matchConfig.squote -= 1;
                }
            } else {
                matchConfig.squote += 1;
            }
        } else if (s === ',' && matchConfig.squote === 0 && matchConfig.dquote === 0 && matchConfig.braces === 0) {
            if (bracket.length <= 1) {
                let functionS = isFunctionRange(str, cellRangeFunction);
                if (functionS.indexOf('#lucky#') > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, '')})`;
                }
                function_str += `${functionS},`;
                str = '';
            } else {
                str += ',';
            }
        } else if (
            s in operatorjson &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            let s_next = '';
            const op = operatorPriority;

            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            if (s + s_next in operatorjson) {
                if (bracket.length === 0) {
                    if (str.trim().length > 0) {
                        cal2.unshift(isFunctionRange(str.trim(), cellRangeFunction));
                    } else if (function_str.trim().length > 0) {
                        cal2.unshift(function_str.trim());
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];

                        while (cal1.length > 0 && stackCeilPri != null) {
                            cal2.unshift(cal1.shift()!);
                            stackCeilPri = op[cal1[0]];
                        }
                    }

                    cal1.unshift(s + s_next);

                    function_str = '';
                    str = '';
                } else {
                    str += s + s_next;
                }

                i += 1;
            } else {
                if (bracket.length === 0) {
                    if (str.trim().length > 0) {
                        cal2.unshift(isFunctionRange(str.trim(), cellRangeFunction));
                    } else if (function_str.trim().length > 0) {
                        cal2.unshift(function_str.trim());
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];
                        stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;

                        let sPri = op[s];
                        sPri = sPri == null ? 1000 : sPri;

                        while (cal1.length > 0 && sPri >= stackCeilPri) {
                            cal2.unshift(cal1.shift()!);

                            stackCeilPri = op[cal1[0]];
                            stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;
                        }
                    }

                    cal1.unshift(s);

                    function_str = '';
                    str = '';
                } else {
                    str += s;
                }
            }
        } else {
            if (matchConfig.dquote === 0 && matchConfig.squote === 0) {
                str += s.trim();
            } else {
                str += s;
            }
        }

        if (i === funcstack.length - 1) {
            let endstr = '';
            let str_nb = str.trim().replace(/'/g, "\\'");
            if (iscelldata(str_nb) && str_nb.substring(0, 1) !== ':') {
                endstr = `luckysheet_getcelldata('${str_nb}')`;
            } else if (str_nb.substring(0, 1) === ':') {
                str_nb = str_nb.substring(1);
                if (iscelldata(str_nb)) {
                    endstr = `luckysheet_getSpecialReference(false,${function_str},'${str_nb}')`;
                }
            } else {
                str = str.trim();

                const arrayMatch = /{.*?}/.exec(str);
                if (arrayMatch && str.substring(0, 1) !== '"' && str.substring(str.length - 1, 1) !== '"') {
                    const [arraytxt] = arrayMatch;
                    const arraystart = arrayMatch.index;

                    if (arraystart > 0) {
                        endstr += str.substring(0, arraystart);
                    }

                    endstr += `luckysheet_getarraydata('${arraytxt}')`;

                    if (arraystart + arraytxt.length < str.length) {
                        endstr += str.substring(arraystart + arraytxt.length, str.length);
                    }
                } else {
                    endstr = str;
                }
            }

            if (endstr.length > 0) {
                cal2.unshift(endstr);
            }

            if (cal1.length > 0) {
                if (function_str.length > 0) {
                    cal2.unshift(function_str);
                    function_str = '';
                }

                for (const operator of cal1.splice(0)) {
                    cal2.unshift(operator);
                }
            }

            if (cal2.length > 0) {
                function_str = calPostfixExpression(cal2);
            } else {
                function_str += endstr;
            }
        }

        i += 1;
    }
    checkSpecialFunctionRange(function_str, cellRangeFunction);
    return function_str;
}

// Hands the quoted range argument of an INDIRECT, OFFSET or INDEX call to cellRangeFunction, once isFunctionRange
// has rewritten the call into its luckysheet_* form.
function checkSpecialFunctionRange(function_str: string, cellRangeFunction: (str: string) => void): void {
    if (
        function_str.substring(0, 30) === 'luckysheet_getSpecialReference' ||
        function_str.substring(0, 20) === 'luckysheet_function.'
    ) {
        if (function_str.substring(0, 20) === 'luckysheet_function.') {
            let funcName = function_str.split('.')[1];
            if (funcName != null) {
                funcName = funcName.toUpperCase();
                if (funcName !== 'INDIRECT' && funcName !== 'OFFSET' && funcName !== 'INDEX') {
                    return;
                }
            }
        }

        const commaParts = function_str.split(',');
        const quoted = commaParts[commaParts.length - 1].split("'");
        if (quoted.length < 2) return;

        const str_nb = quoted[1].trim();
        if (iscelldata(str_nb)) {
            cellRangeFunction(str_nb);
        }
    }
}
