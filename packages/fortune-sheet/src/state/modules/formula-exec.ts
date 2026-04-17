/**
 * Context-coupled formula execution functions.
 *
 * These functions inherently read/write Context (formula caches, sheet data,
 * calc chains, etc.) and therefore belong in the state layer.
 *
 * Extracted from engine/formula-calc.ts so that the engine directory has zero
 * state-runtime dependencies.
 */
import _ from "lodash";
import type {
    Cell,
    CellMatrix,
    FormulaCell,
    FormulaDependency,
} from "../types";
import { Context, getFlowdata } from "../context";
import { columnCharToIndex, getSheetIndex } from "../utils";
import { setCellValue } from "./cell";
import { error } from "./validation";
import {
    arrayMatch,
    executeAffectedFormulas,
    getFormulaRunList,
    setFormulaCellInfo,
} from "./formulaHelper";
import {
    iscelldata,
    operatorjson,
    operatorPriority,
    calPostfixExpression,
    checkBracketNum,
} from "../../engine/formula-utils";

// ─── Regex for cell label extraction ───────────────────────────────────────

const simpleSheetName = "[A-Za-z0-9_\u00C0-\u02AF]+";
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
const rowColumnRegexp = `[$]?[A-Za-z]+[$]?[0-9]+`;
const rowColumnWithSheetName = `(?:${sheetNameRegexp})?(${rowColumnRegexp})`;
const LABEL_EXTRACT_REGEXP = new RegExp(
    `^${rowColumnWithSheetName}(?:[:]${rowColumnWithSheetName})?$`
);

// ─── Private helpers ───────────────────────────────────────────────────────

function addToCellIndexList(ctx: Context, txt: string, infoObj: any): void {
    if (txt == null || txt.length === 0 || infoObj == null) {
        return;
    }
    if (ctx.formulaCache.cellTextToIndexList == null) {
        ctx.formulaCache.cellTextToIndexList = {};
    }

    if (txt.indexOf("!") > -1) {
        txt = txt.replace(/\\'/g, "'").replace(/''/g, "'");
        ctx.formulaCache.cellTextToIndexList[txt] = infoObj;
    } else {
        ctx.formulaCache.cellTextToIndexList[`${txt}_${infoObj.sheetId}`] = infoObj;
    }
}

function checkSpecialFunctionRange(
    ctx: Context,
    function_str: string,
    r: number | null,
    c: number | null,
    id: string,
    dynamicArray_compute?: any,
    cellRangeFunction?: any
): void {
    if (
        function_str.substring(0, 30) === "luckysheet_getSpecialReference" ||
        function_str.substring(0, 20) === "luckysheet_function."
    ) {
        if (function_str.substring(0, 20) === "luckysheet_function.") {
            let funcName = function_str.split(".")[1];
            if (funcName != null) {
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

function insertUpdateDynamicArray(ctx: Context, dynamicArrayItem: any): any[] {
    const { r, c } = dynamicArrayItem;
    let { id } = dynamicArrayItem;
    if (id == null) {
        id = ctx.currentSheetId;
    }

    const { luckysheetfile } = ctx;
    const idx = getSheetIndex(ctx, id);
    if (idx == null) return [];

    const file = luckysheetfile[idx];

    let { dynamicArray } = file;
    if (dynamicArray == null) {
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

// ─── Exported functions ────────────────────────────────────────────────────

export function getcellrange(
    ctx: Context,
    txt: string,
    formulaId?: string,
    data?: CellMatrix
): FormulaDependency | null {
    if (txt == null || txt.length === 0) {
        return null;
    }
    const flowdata = data || getFlowdata(ctx, formulaId);

    let sheettxt = "";
    let rangetxt = "";
    let sheetId;
    let sheetdata = null;

    const { luckysheetfile } = ctx;

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
        if (i == null) {
            i = ctx.currentSheetId;
        }
        if (`${txt}_${i}` in ctx.formulaCache.cellTextToIndexList) {
            return ctx.formulaCache.cellTextToIndexList[`${txt}_${i}`];
        }
        const index = getSheetIndex(ctx, i);
        if (index == null) {
            return null;
        }
        sheettxt = luckysheetfile[index].name;
        sheetId = luckysheetfile[index].id;
        sheetdata = flowdata;
        rangetxt = txt;
    }

    if (sheetdata == null) {
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

export function isFunctionRange(
    ctx: Context,
    txt: string,
    r: number | null,
    c: number | null,
    id: string,
    dynamicArray_compute: any,
    cellRangeFunction: any
): string {
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

                        while (cal1.length > 0 && stackCeilPri != null) {
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
                        stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;

                        let sPri = op[s];
                        sPri = sPri == null ? 1000 : sPri;

                        while (cal1.length > 0 && sPri >= stackCeilPri) {
                            cal2.unshift(cal1.shift());

                            stackCeilPri = op[cal1[0]];
                            stackCeilPri = stackCeilPri == null ? 1000 : stackCeilPri;
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

export function getAllFunctionGroup(ctx: Context): FormulaCell[] {
    const { luckysheetfile } = ctx;
    let ret: FormulaCell[] = [];
    for (let i = 0; i < luckysheetfile.length; i += 1) {
        const file = luckysheetfile[i];
        let { calcChain } = file;

        let { dynamicArray_compute } = file;
        if (calcChain == null) {
            calcChain = [];
        }

        if (dynamicArray_compute == null) {
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
): void {
    if (id == null) {
        id = ctx.currentSheetId;
    }

    const file = ctx.luckysheetfile[getSheetIndex(ctx, id)!];

    const { calcChain } = file;
    if (calcChain != null) {
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

    const { dynamicArray } = file;
    if (dynamicArray != null) {
        let modified = false;
        const dynamicArrayClone = dynamicArray.slice();
        for (let i = 0; i < dynamicArrayClone.length; i += 1) {
            const calc = dynamicArrayClone[i];
            if (
                calc.r === r &&
                calc.c === c &&
                (calc.id == null || calc.id === id)
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
): void {
    if (id == null) {
        id = ctx.currentSheetId;
    }

    const { luckysheetfile } = ctx;
    const idx = getSheetIndex(ctx, id);
    if (idx == null) {
        return;
    }
    const file = luckysheetfile[idx];

    let { calcChain } = file;
    if (calcChain == null) {
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

    if (id == null) {
        id = ctx.currentSheetId;
    }

    ctx.calculateSheetId = id;

    ctx.formulaCache.parser.context = ctx;
    const parsedResponse = ctx.formulaCache.parser.parse(txt.substring(1), {
        sheetId: id || ctx.currentSheetId,
    });

    const { error: formulaError } = parsedResponse;
    let { result } = parsedResponse;

    // https://stackoverflow.com/a/643827/8200626
    // https://github.com/ruilisi/fortune-sheet/issues/551
    if (
        Object.prototype.toString.call(result) === "[object Date]" &&
        result != null
    ) {
        result = result.toString();
    }

    if (r != null && c != null) {
        if (isrefresh) {
            // eslint-disable-next-line no-use-before-define
            execFunctionGroup(
                ctx,
                r,
                c,
                formulaError == null ? result : formulaError,
                id
            );
        }

        if (!notInsertFunc) {
            insertUpdateFunctionGroup(ctx, r, c, id, calcChainSet);
        }
    }

    return [true, formulaError == null ? result : formulaError, txt];
}

export function groupValuesRefresh(ctx: Context): void {
    const { luckysheetfile } = ctx;
    if (ctx.groupValuesRefreshData.length > 0) {
        for (let i = 0; i < ctx.groupValuesRefreshData.length; i += 1) {
            const item = ctx.groupValuesRefreshData[i];

            const idx = getSheetIndex(ctx, item.id);
            if (idx == null) continue;

            const file = luckysheetfile[idx];
            const { data } = file;
            if (data == null) {
                continue;
            }

            const updateValue: any = {};
            if (item.spe != null) {
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
): void {
    if (calcChains == null) return;
    for (let i = 0; i < calcChains.length; i += 1) {
        const formulaCell = calcChains[i];
        setFormulaCellInfo(ctx, formulaCell, data);
    }
}

export function execFunctionGroup(
    ctx: Context,
    origin_r: number | null,
    origin_c: number | null,
    value: any,
    id?: string,
    data?: any,
    isForce = false
): void {
    // 0. null checks
    if (data == null) {
        data = getFlowdata(ctx);
    }

    if (ctx.formulaCache.execFunctionGlobalData == null) {
        ctx.formulaCache.execFunctionGlobalData = {};
    }
    if (id == null) {
        id = ctx.currentSheetId;
    }

    if (value != null) {
        const cellCache: Cell[][] = [[{ v: undefined }]];
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
    if (ctx.formulaCache.execFunctionExist == null) {
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
    const { formulaCellInfoMap } = ctx.formulaCache;

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
