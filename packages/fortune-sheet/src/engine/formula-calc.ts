import _ from "lodash";
import type {Cell, CellMatrix, FormulaCell, FormulaDependency,} from "../state/types";
import {Context, getFlowdata} from "../state/context";
import {columnCharToIndex, getSheetIndex,} from "../state/utils";
import {setCellValue} from "../state/modules/cell";
import {error} from "../state/modules/validation";
import {arrayMatch, executeAffectedFormulas, getFormulaRunList, setFormulaCellInfo,} from "../state/modules/formulaHelper";
const operatorPriority: any = {
    "^": 0,
    "%": 1,
    "*": 1,
    "/": 1,
    "+": 2,
    "-": 2,
};
const operatorArr = "==|!=|<>|<=|>=|=|+|-|>|<|/|*|%|&|^".split("|");
export const operatorjson: Record<string, number> = {};
for (let i = 0; i < operatorArr.length; i += 1) {
    operatorjson[operatorArr[i].toString()] = 1;
}

const simpleSheetName = "[A-Za-z0-9_\u00C0-\u02AF]+";
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
const rowColumnRegexp = `[$]?[A-Za-z]+[$]?[0-9]+`;
const rowColumnWithSheetName = `(?:${sheetNameRegexp})?(${rowColumnRegexp})`;
const LABEL_EXTRACT_REGEXP = new RegExp(
    `^${rowColumnWithSheetName}(?:[:]${rowColumnWithSheetName})?$`
);

export function iscelldata(txt: string) {
    // Check whether the format is a cell reference format
    const val = txt.split("!");
    let rangetxt: string;

    if (val.length > 1) {
        [, rangetxt] = val;
    } else {
        [rangetxt] = val;
    }

    const reg_cell = /^(([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+))$/g; // Added regex to check cell references in letter+number format, e.g. A1:B3
    let reg_cellRange =
        /^(((([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+)))|((([a-zA-Z]+)|([$][a-zA-Z]+))))$/g; // Added regex to check cell references in letter+number or letter-only format, e.g. A1:B3, A:A

    if (rangetxt.indexOf(":") === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ""), 10) - 1;
        const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ""));

        if (
            !Number.isNaN(row) &&
            !Number.isNaN(col) &&
            rangetxt.toString().match(reg_cell)
        ) {
            return true;
        }
        if (!Number.isNaN(row)) {
            return false;
        }
        if (!Number.isNaN(col)) {
            return false;
        }

        return false;
    }

    reg_cellRange =
        /^(((([a-zA-Z]+)|([$][a-zA-Z]+))(([0-9]+)|([$][0-9]+)))|((([a-zA-Z]+)|([$][a-zA-Z]+)))|((([0-9]+)|([$][0-9]+s))))$/g;

    const rangetxtArr = rangetxt.split(":");

    const row = [];
    const col = [];
    row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ""), 10) - 1;
    row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ""), 10) - 1;
    if (row[0] > row[1]) {
        return false;
    }

    col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ""));
    col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ""));
    if (col[0] > col[1]) {
        return false;
    }

    if (
        rangetxtArr[0].toString().match(reg_cellRange) &&
        rangetxtArr[1].toString().match(reg_cellRange)
    ) {
        return true;
    }

    return false;
}

function addToCellIndexList(ctx: Context, txt: string, infoObj: any) {
    if (_.isNil(txt) || txt.length === 0 || _.isNil(infoObj)) {
        return;
    }
    if (_.isNil(ctx.formulaCache.cellTextToIndexList)) {
        ctx.formulaCache.cellTextToIndexList = {};
    }

    if (txt.indexOf("!") > -1) {
        txt = txt.replace(/\\'/g, "'").replace(/''/g, "'");
        ctx.formulaCache.cellTextToIndexList[txt] = infoObj;
    } else {
        ctx.formulaCache.cellTextToIndexList[`${txt}_${infoObj.sheetId}`] = infoObj;
    }
}

export function getcellrange(
    ctx: Context,
    txt: string,
    formulaId?: string,
    data?: CellMatrix
): FormulaDependency | null {
    if (_.isNil(txt) || txt.length === 0) {
        return null;
    }
    const flowdata = data || getFlowdata(ctx, formulaId);

    let sheettxt = "";
    let rangetxt = "";
    let sheetId;
    let sheetdata = null;

    const {luckysheetfile} = ctx;

    if (txt.indexOf("!") > -1) {
        if (txt in ctx.formulaCache.cellTextToIndexList) {
            return ctx.formulaCache.cellTextToIndexList[txt];
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
        sheettxt = sheettxt1
            .replace(/^'|'$/g, "")
            .replace(/\\'/g, "'")
            .replace(/''/g, "'");

        _.forEach(luckysheetfile, (f) => {
            if (sheettxt === f.name) {
                sheetId = f.id;
                sheetdata = f.data;
                return false;
            }
            return true;
        });
    } else {
        let i = formulaId;
        if (_.isNil(i)) {
            i = ctx.currentSheetId;
        }
        if (`${txt}_${i}` in ctx.formulaCache.cellTextToIndexList) {
            return ctx.formulaCache.cellTextToIndexList[`${txt}_${i}`];
        }
        const index = getSheetIndex(ctx, i);
        if (_.isNil(index)) {
            return null;
        }
        sheettxt = luckysheetfile[index].name;
        sheetId = luckysheetfile[index].id;
        sheetdata = flowdata;
        rangetxt = txt;
    }

    if (_.isNil(sheetdata)) {
        return null;
    }

    if (rangetxt.indexOf(":") === -1) {
        const row = parseInt(rangetxt.replace(/[^0-9]/g, ""), 10) - 1;
        const col = columnCharToIndex(rangetxt.replace(/[^A-Za-z]/g, ""));

        if (!Number.isNaN(row) && !Number.isNaN(col)) {
            const item: FormulaDependency = {
                row: [row, row],
                column: [col, col],
                sheetId,
            };
            addToCellIndexList(ctx, txt, item);
            return item;
        }
        return null;
    }
    const rangetxtArr = rangetxt.split(":");
    const row: [number, number] = [-1, -1];
    const col: [number, number] = [-1, -1];
    row[0] = parseInt(rangetxtArr[0].replace(/[^0-9]/g, ""), 10) - 1;
    row[1] = parseInt(rangetxtArr[1].replace(/[^0-9]/g, ""), 10) - 1;
    if (Number.isNaN(row[0])) {
        row[0] = 0;
    }
    if (Number.isNaN(row[1])) {
        row[1] = sheetdata.length - 1;
    }
    if (row[0] > row[1]) {
        return null;
    }
    col[0] = columnCharToIndex(rangetxtArr[0].replace(/[^A-Za-z]/g, ""));
    col[1] = columnCharToIndex(rangetxtArr[1].replace(/[^A-Za-z]/g, ""));
    if (Number.isNaN(col[0])) {
        col[0] = 0;
    }
    if (Number.isNaN(col[1])) {
        col[1] = sheetdata[0].length - 1;
    }
    if (col[0] > col[1]) {
        return null;
    }

    const item: FormulaDependency = {
        row,
        column: col,
        sheetId,
    };
    addToCellIndexList(ctx, txt, item);
    return item;
}

function calPostfixExpression(cal: any[]) {
    if (cal.length === 0) {
        return "";
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

    return "";
}

function checkSpecialFunctionRange(
    ctx: Context,
    function_str: string,
    r: number | null,
    c: number | null,
    id: string,
    dynamicArray_compute?: any,
    cellRangeFunction?: any
) {
    if (
        function_str.substring(0, 30) === "luckysheet_getSpecialReference" ||
        function_str.substring(0, 20) === "luckysheet_function."
    ) {
        if (function_str.substring(0, 20) === "luckysheet_function.") {
            let funcName = function_str.split(".")[1];
            if (!_.isNil(funcName)) {
                funcName = funcName.toUpperCase();
                if (
                    funcName !== "INDIRECT" &&
                    funcName !== "OFFSET" &&
                    funcName !== "INDEX"
                ) {
                    return;
                }
            }
        }
        try {
            ctx.calculateSheetId = id;
            const str = function_str
                .split(",")
                [function_str.split(",").length - 1].split("'")[1]
                .split("'")[0];

            const str_nb = _.trim(str);
            if (iscelldata(str_nb)) {
                if (typeof cellRangeFunction === "function") {
                    cellRangeFunction(str_nb);
                }
            }
        } catch {
        }
    }
}

export function isFunctionRange(
    ctx: Context,
    txt: string,
    r: number | null,
    c: number | null,
    id: string,
    dynamicArray_compute: any,
    cellRangeFunction: any
) {
    if (txt.substring(0, 1) === "=") {
        txt = txt.substring(1);
    }

    const funcstack = txt.split("");
    let i = 0;
    let str = "";
    let function_str = "";

    const matchConfig = {
        bracket: 0,
        comma: 0,
        squote: 0,
        dquote: 0,
        compare: 0,
        braces: 0,
    };

    // bracket: 0 = operator bracket, 1 = function bracket
    const cal1: any[] = [];
    const cal2: any[] = [];
    const bracket: any[] = [];
    while (i < funcstack.length) {
        const s = funcstack[i];

        if (
            s === "(" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            if (str.length > 0 && bracket.length === 0) {
                str = str.toUpperCase();
                if (str.indexOf(":") > -1) {
                    const funcArray = str.split(":");
                    function_str += `luckysheet_getSpecialReference(true,'${_.trim(
                        funcArray[0]
                    ).replace(/'/g, "\\'")}', luckysheet_function.${
                        funcArray[1]
                    }.f(#lucky#`;
                } else {
                    function_str += `luckysheet_function.${str}.f(`;
                }
                bracket.push(1);
                str = "";
            } else if (bracket.length === 0) {
                function_str += "(";
                bracket.push(0);
                str = "";
            } else {
                bracket.push(0);
                str += s;
            }
        } else if (
            s === ")" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            bracket.pop();

            if (bracket.length === 0) {
                let functionS = isFunctionRange(
                    ctx,
                    str,
                    r,
                    c,
                    id,
                    dynamicArray_compute,
                    cellRangeFunction
                );
                if (functionS.indexOf("#lucky#") > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, "")})`;
                }
                function_str += `${functionS})`;
                str = "";
            } else {
                str += s;
            }
        } else if (
            s === "{" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0
        ) {
            str += "{";
            matchConfig.braces += 1;
        } else if (
            s === "}" &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0
        ) {
            str += "}";
            matchConfig.braces -= 1;
        } else if (s === '"' && matchConfig.squote === 0) {
            if (matchConfig.dquote > 0) {
                // If "" is found, it represents an escaped quote character "
                if (i < funcstack.length - 1 && funcstack[i + 1] === '"') {
                    i += 1;
                    str += "\x7F"; // Replace "" with DEL character
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
                // if (firstSQ === i - 1) // The first character after a matching single quote cannot be a single quote
                // {
                //    Reaching this point indicates a formula error
                // }
                // If '' is found, it represents an escaped single quote character '
                if (i < funcstack.length - 1 && funcstack[i + 1] === "'") {
                    i += 1;
                    str += "'";
                } else {
                    // If the next character is not ', the single-quoted string is ended
                    // if (funcstack[i - 1] === "'") { // The last character before a matching single quote cannot be a single quote
                    //    Reaching this point indicates a formula error
                    // } else {
                    matchConfig.squote -= 1;
                    // }
                }
            } else {
                matchConfig.squote += 1;
            }
        } else if (
            s === "," &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            if (bracket.length <= 1) {
                let functionS = isFunctionRange(
                    ctx,
                    str,
                    r,
                    c,
                    id,
                    dynamicArray_compute,
                    cellRangeFunction
                );
                if (functionS.indexOf("#lucky#") > -1) {
                    functionS = `${functionS.replace(/#lucky#/g, "")})`;
                }
                function_str += `${functionS},`;
                str = "";
            } else {
                str += ",";
            }
        } else if (
            s in operatorjson &&
            matchConfig.squote === 0 &&
            matchConfig.dquote === 0 &&
            matchConfig.braces === 0
        ) {
            let s_next = "";
            const op = operatorPriority;

            if (i + 1 < funcstack.length) {
                s_next = funcstack[i + 1];
            }

            if (s + s_next in operatorjson) {
                if (bracket.length === 0) {
                    if (_.trim(str).length > 0) {
                        cal2.unshift(
                            isFunctionRange(
                                ctx,
                                _.trim(str),
                                r,
                                c,
                                id,
                                dynamicArray_compute,
                                cellRangeFunction
                            )
                        );
                    } else if (_.trim(function_str).length > 0) {
                        cal2.unshift(_.trim(function_str));
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];

                        while (cal1.length > 0 && !_.isNil(stackCeilPri)) {
                            cal2.unshift(cal1.shift());
                            stackCeilPri = op[cal1[0]];
                        }
                    }

                    cal1.unshift(s + s_next);

                    function_str = "";
                    str = "";
                } else {
                    str += s + s_next;
                }

                i += 1;
            } else {
                if (bracket.length === 0) {
                    if (_.trim(str).length > 0) {
                        cal2.unshift(
                            isFunctionRange(
                                ctx,
                                _.trim(str),
                                r,
                                c,
                                id,
                                dynamicArray_compute,
                                cellRangeFunction
                            )
                        );
                    } else if (_.trim(function_str).length > 0) {
                        cal2.unshift(_.trim(function_str));
                    }

                    if (cal1[0] in operatorjson) {
                        let stackCeilPri = op[cal1[0]];
                        stackCeilPri = _.isNil(stackCeilPri) ? 1000 : stackCeilPri;

                        let sPri = op[s];
                        sPri = _.isNil(sPri) ? 1000 : sPri;

                        while (cal1.length > 0 && sPri >= stackCeilPri) {
                            cal2.unshift(cal1.shift());

                            stackCeilPri = op[cal1[0]];
                            stackCeilPri = _.isNil(stackCeilPri) ? 1000 : stackCeilPri;
                        }
                    }

                    cal1.unshift(s);

                    function_str = "";
                    str = "";
                } else {
                    str += s;
                }
            }
        } else {
            if (matchConfig.dquote === 0 && matchConfig.squote === 0) {
                str += _.trim(s);
            } else {
                str += s;
            }
        }

        if (i === funcstack.length - 1) {
            let endstr = "";
            let str_nb = _.trim(str).replace(/'/g, "\\'");
            if (iscelldata(str_nb) && str_nb.substring(0, 1) !== ":") {
                // endstr = "luckysheet_getcelldata('" + _.trim(str) + "')";
                endstr = `luckysheet_getcelldata('${str_nb}')`;
            } else if (str_nb.substring(0, 1) === ":") {
                str_nb = str_nb.substring(1);
                if (iscelldata(str_nb)) {
                    endstr = `luckysheet_getSpecialReference(false,${function_str},'${str_nb}')`;
                }
            } else {
                str = _.trim(str);

                const regx = /{.*?}/;
                if (
                    regx.test(str) &&
                    str.substring(0, 1) !== '"' &&
                    str.substring(str.length - 1, 1) !== '"'
                ) {
                    const arraytxt = regx.exec(str)?.[0];
                    const arraystart = str.search(regx);

                    if (arraystart > 0) {
                        endstr += str.substring(0, arraystart);
                    }

                    endstr += `luckysheet_getarraydata('${arraytxt}')`;

                    if (arraystart + arraytxt!.length < str.length) {
                        endstr += str.substring(arraystart + arraytxt!.length, str.length);
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
                    function_str = "";
                }

                while (cal1.length > 0) {
                    cal2.unshift(cal1.shift());
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
    checkSpecialFunctionRange(
        ctx,
        function_str,
        r,
        c,
        id,
        dynamicArray_compute,
        cellRangeFunction
    );
    return function_str;
}

export function getAllFunctionGroup(ctx: Context) {
    const {luckysheetfile} = ctx;
    let ret: FormulaCell[] = [];
    for (let i = 0; i < luckysheetfile.length; i += 1) {
        const file = luckysheetfile[i];
        let {calcChain} = file;

        let {dynamicArray_compute} = file;
        if (_.isNil(calcChain)) {
            calcChain = [];
        }

        if (_.isNil(dynamicArray_compute)) {
            dynamicArray_compute = [];
        }

        ret = ret.concat(calcChain);

        for (let j = 0; j < dynamicArray_compute.length; j += 1) {
            const d = dynamicArray_compute[0];
            ret.push({
                r: d.r,
                c: d.c,
                id: d.id,
            });
        }
    }

    return ret;
}

export function delFunctionGroup(
    ctx: Context,
    r: number,
    c: number,
    id?: string
) {
    if (_.isNil(id)) {
        id = ctx.currentSheetId;
    }

    const file = ctx.luckysheetfile[getSheetIndex(ctx, id)!];

    const {calcChain} = file;
    if (!_.isNil(calcChain)) {
        let modified = false;
        const calcChainClone = calcChain.slice();
        for (let i = 0; i < calcChainClone.length; i += 1) {
            const calc = calcChainClone[i];
            if (calc.r === r && calc.c === c && calc.id === id) {
                calcChainClone.splice(i, 1);
                modified = true;
                break;
            }
        }
        if (modified) {
            file.calcChain = calcChainClone;
        }
    }

    const {dynamicArray} = file;
    if (!_.isNil(dynamicArray)) {
        let modified = false;
        const dynamicArrayClone = dynamicArray.slice();
        for (let i = 0; i < dynamicArrayClone.length; i += 1) {
            const calc = dynamicArrayClone[i];
            if (
                calc.r === r &&
                calc.c === c &&
                (_.isNil(calc.id) || calc.id === id)
            ) {
                dynamicArrayClone.splice(i, 1);
                modified = true;
                break;
            }
        }
        if (modified) {
            file.dynamicArray = dynamicArrayClone;
        }
    }
}

export function insertUpdateFunctionGroup(
    ctx: Context,
    r: number,
    c: number,
    id?: string,
    calcChainSet?: Set<string>
) {
    if (_.isNil(id)) {
        id = ctx.currentSheetId;
    }

    const {luckysheetfile} = ctx;
    const idx = getSheetIndex(ctx, id);
    if (_.isNil(idx)) {
        return;
    }
    const file = luckysheetfile[idx];

    let {calcChain} = file;
    if (_.isNil(calcChain)) {
        calcChain = [];
    }

    if (calcChainSet) {
        if (calcChainSet.has(`${r}_${c}_${id}`)) return;
    } else {
        for (let i = 0; i < calcChain.length; i += 1) {
            const calc = calcChain[i];
            if (calc.r === r && calc.c === c && calc.id === id) {
                return;
            }
        }
    }

    const cc = {
        r,
        c,
        id,
    };
    calcChain.push(cc);
    file.calcChain = calcChain;
    ctx.luckysheetfile = luckysheetfile;
}

export function checkBracketNum(fp: string) {
    const bra_l = fp.match(/\(/g);
    const bra_r = fp.match(/\)/g);
    const bra_tl_txt = fp.match(/(['"])(?:(?!\1).)*?\1/g);
    const bra_tr_txt = fp.match(/(['"])(?:(?!\1).)*?\1/g);

    let bra_l_len = 0;
    let bra_r_len = 0;
    if (!_.isNil(bra_l)) {
        bra_l_len += bra_l.length;
    }
    if (!_.isNil(bra_r)) {
        bra_r_len += bra_r.length;
    }

    let bra_tl_len = 0;
    let bra_tr_len = 0;
    if (!_.isNil(bra_tl_txt)) {
        for (let i = 0; i < bra_tl_txt.length; i += 1) {
            const bra_tl = bra_tl_txt[i].match(/\(/g);
            if (!_.isNil(bra_tl)) {
                bra_tl_len += bra_tl.length;
            }
        }
    }

    if (!_.isNil(bra_tr_txt)) {
        for (let i = 0; i < bra_tr_txt.length; i += 1) {
            const bra_tr = bra_tr_txt[i].match(/\)/g);
            if (!_.isNil(bra_tr)) {
                bra_tr_len += bra_tr.length;
            }
        }
    }

    bra_l_len -= bra_tl_len;
    bra_r_len -= bra_tr_len;

    if (bra_l_len !== bra_r_len) {
        return false;
    }

    return true;
}

export function execfunction(
    ctx: Context,
    txt: string,
    r: number,
    c: number,
    id?: string,
    calcChainSet?: Set<string>,
    isrefresh?: boolean,
    notInsertFunc?: boolean
) {
    if (txt.indexOf(error.r) > -1) {
        return [false, error.r, txt];
    }

    if (!checkBracketNum(txt)) {
        txt += ")";
    }

    if (_.isNil(id)) {
        id = ctx.currentSheetId;
    }

    ctx.calculateSheetId = id;

    ctx.formulaCache.parser.context = ctx;
    const parsedResponse = ctx.formulaCache.parser.parse(txt.substring(1), {
        sheetId: id || ctx.currentSheetId,
    });

    const {error: formulaError} = parsedResponse;
    let {result} = parsedResponse;

    // https://stackoverflow.com/a/643827/8200626
    // https://github.com/ruilisi/fortune-sheet/issues/551
    if (
        Object.prototype.toString.call(result) === "[object Date]" &&
        !_.isNil(result)
    ) {
        result = result.toString();
    }

    if (!_.isNil(r) && !_.isNil(c)) {
        if (isrefresh) {
            // eslint-disable-next-line no-use-before-define
            execFunctionGroup(
                ctx,
                r,
                c,
                _.isNil(formulaError) ? result : formulaError,
                id
            );
        }

        if (!notInsertFunc) {
            insertUpdateFunctionGroup(ctx, r, c, id, calcChainSet);
        }
    }

    return [true, _.isNil(formulaError) ? result : formulaError, txt];
}

function insertUpdateDynamicArray(ctx: Context, dynamicArrayItem: any) {
    const {r, c} = dynamicArrayItem;
    let {id} = dynamicArrayItem;
    if (_.isNil(id)) {
        id = ctx.currentSheetId;
    }

    const {luckysheetfile} = ctx;
    const idx = getSheetIndex(ctx, id);
    if (idx == null) return [];

    const file = luckysheetfile[idx];

    let {dynamicArray} = file;
    if (_.isNil(dynamicArray)) {
        dynamicArray = [];
    }

    for (let i = 0; i < dynamicArray.length; i += 1) {
        const calc = dynamicArray[i];
        if (calc.r === r && calc.c === c && calc.id === id) {
            calc.data = dynamicArrayItem.data;
            calc.f = dynamicArrayItem.f;
            return dynamicArray;
        }
    }

    dynamicArray.push(dynamicArrayItem);
    return dynamicArray;
}

export function groupValuesRefresh(ctx: Context) {
    const {luckysheetfile} = ctx;
    if (ctx.groupValuesRefreshData.length > 0) {
        for (let i = 0; i < ctx.groupValuesRefreshData.length; i += 1) {
            const item = ctx.groupValuesRefreshData[i];

            // if(item.i !== ctx.currentSheetId){
            //     continue;
            // }

            const idx = getSheetIndex(ctx, item.id);
            if (idx == null) continue;

            const file = luckysheetfile[idx];
            const {data} = file;
            if (_.isNil(data)) {
                continue;
            }

            const updateValue: any = {};
            if (!_.isNil(item.spe)) {
                if (item.spe.type === "sparklines") {
                    updateValue.spl = item.spe.data;
                } else if (item.spe.type === "dynamicArrayItem") {
                    file.dynamicArray = insertUpdateDynamicArray(ctx, item.spe.data);
                }
            }
            updateValue.v = item.v;
            updateValue.f = item.f;
            setCellValue(ctx, item.r, item.c, data, updateValue);
        }

        ctx.groupValuesRefreshData = [];
    }
}

export function setFormulaCellInfoMap(
    ctx: Context,
    calcChains?: any[],
    data?: CellMatrix
) {
    if (_.isNil(calcChains)) return;
    for (let i = 0; i < calcChains.length; i += 1) {
        const formulaCell = calcChains[i];
        setFormulaCellInfo(ctx, formulaCell, data);
    }
}

export function execFunctionGroup(
    ctx: Context,
    origin_r: number,
    origin_c: number,
    value: any,
    id?: string,
    data?: any,
    isForce = false
) {
    // 0. null checks
    if (_.isNil(data)) {
        data = getFlowdata(ctx);
    }

    if (_.isNil(ctx.formulaCache.execFunctionGlobalData)) {
        ctx.formulaCache.execFunctionGlobalData = {};
    }
    if (_.isNil(id)) {
        id = ctx.currentSheetId;
    }

    if (!_.isNil(value)) {
        const cellCache: Cell[][] = [[{v: undefined}]];
        setCellValue(ctx, 0, 0, cellCache, value);
        [
            [
                ctx.formulaCache.execFunctionGlobalData[
                    `${origin_r}_${origin_c}_${id}`
                    ],
            ],
        ] = cellCache;
    }

    // 1. get list of all functions in the sheet
    const calcChains: FormulaCell[] = getAllFunctionGroup(ctx);

    // 2. Store the cells involved in the modification
    const updateValueObjects: any = {};
    if (_.isNil(ctx.formulaCache.execFunctionExist)) {
        const key = `r${origin_r}c${origin_c}i${id}`;
        updateValueObjects[key] = 1;
    } else {
        for (let x = 0; x < ctx.formulaCache.execFunctionExist.length; x += 1) {
            const cell = ctx.formulaCache.execFunctionExist[x] as any;
            const key = `r${cell.r}c${cell.c}i${cell.i}`;
            updateValueObjects[key] = 1;
        }
    }

    // 3. formulaCellInfoMap: a cache of ALL formulas vs their ranges
    if (
        !ctx.formulaCache.formulaCellInfoMap ||
        _.isEmpty(ctx.formulaCache.formulaCellInfoMap)
    ) {
        ctx.formulaCache.formulaCellInfoMap = {};
        setFormulaCellInfoMap(ctx, calcChains, data);
    }
    const {formulaCellInfoMap} = ctx.formulaCache;

    // 4. Form a graph structure of references between formulas
    // basically fills parents in formulaCellInfoMap[i]
    const updateValueArray: any = [];
    const arrayMatchCache: Record<
        string,
        { key: string; r: number; c: number; sheetId: string }[]
    > = {};
    Object.keys(formulaCellInfoMap).forEach((key) => {
        const formulaObject = formulaCellInfoMap[key];
        arrayMatch(
            arrayMatchCache,
            formulaObject.formulaDependency,
            formulaCellInfoMap,
            updateValueObjects,
            (childKey: string) => {
                if (childKey in formulaCellInfoMap) {
                    const childFormulaObject = formulaCellInfoMap[childKey];
                    // formulaObject.chidren[childKey] = 1; not needed
                    childFormulaObject.parents[key] = 1;
                }
                if (!isForce && childKey in updateValueObjects) {
                    updateValueArray.push(formulaObject);
                }
            }
        );

        if (isForce) {
            updateValueArray.push(formulaObject);
        }
    });

    // 5. Get list of affected formulas using the graph structure by depth-first traversal
    const formulaRunList = getFormulaRunList(
        updateValueArray,
        formulaCellInfoMap
    );

    // 6. execute relevant formulas
    executeAffectedFormulas(ctx, formulaRunList, calcChains);

    ctx.formulaCache.execFunctionExist = undefined;
}
