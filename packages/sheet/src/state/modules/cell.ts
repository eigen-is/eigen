import type { BorderSide, MergeCell } from '@workspace/lib/sheets';
import {
    cloneDeep,
    every,
    indexOf,
    isEmpty,
    isNil,
    isNumber,
    isPlainObject,
    isString,
    kebabCase,
    map,
} from 'es-toolkit/compat';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import { genarate, update } from '../../engine/format';
import { isFormula } from '../../engine/formula-engine';
import { iscelldata } from '../../engine/formula-utils';
import type { Cell, CellMatrix, CellType, FormulaDependency } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { Range, RangeOrWholeAxis, Selection, SheetConfig } from '../types';
import { getSheetIndex, indexToColumnChar, rgbToHex } from '../utils';
import { checkCF, getComputeMap } from './condition-format';
import { getFailureText, validateCellData } from './data-verification';
import { setFormulaCellInfo } from './formula-cache';
import { functionHTMLGenerate } from './formula-editor';
import { delFunctionGroup, execFunctionGroup, execfunction, getcellrange } from './formula-exec';
import {
    convertSpanToShareString,
    cssDomKeyForAttr,
    isInlineStringCell,
    isInlineStringCT,
    type StyleAttr,
    type UnderlineHints,
} from './inline-string';
import { getCellTextInfo } from './text';
import { isRealNull, isRealNum, valueIsError } from './validation';

// TODO put these in context ref
// let rangestart = false;
// let rangedrag_column_start = false;
// let rangedrag_row_start = false;

// Returns the cell attribute value, normalized to a default when missing. Result is a
// value-space union (string for color/format/alignment, number for fs, CellType for ct, …);
// callers narrow at use, e.g. `Number(value)` or `String(value)` per attr.
// biome-ignore lint/suspicious/noExplicitAny: per-attr return shape varies (string default vs Cell[attr]); tightening forces casts at every call site
export function normalizedCellAttr(cell: Cell, attr: keyof Cell, defaultFontSize = 10): any {
    const tf = { bl: 1, it: 1, ff: 1, cl: 1, un: 1 };
    // biome-ignore lint/suspicious/noExplicitAny: same union as the return type
    let value: any = cell?.[attr];

    if (attr in tf || (attr === 'fs' && isInlineStringCell(cell))) {
        value ||= '0';
    } else if (['fc', 'bg', 'bc'].includes(attr)) {
        if (['fc', 'bc'].includes(attr)) {
            value ||= '#000000';
        }
        if (value?.indexOf('rgba') > -1) {
            value = rgbToHex(value);
        }
    } else if (attr.substring(0, 2) === 'bs') {
        value ||= 'none';
    } else if (attr === 'ht' || attr === 'vt') {
        const defaultValue = attr === 'ht' ? '1' : '0';
        value = !isNil(value) ? value.toString() : defaultValue;
        if (['0', '1', '2'].indexOf(value.toString()) === -1) {
            value = defaultValue;
        }
    } else if (attr === 'fs') {
        value ||= defaultFontSize.toString();
    } else if (attr === 'tb') {
        value ||= '0';
    }

    return value;
}

// biome-ignore lint/suspicious/noExplicitAny: passes through normalizedCellAttr's per-attr union
export function normalizedAttr(data: CellMatrix, r: number, c: number, attr: keyof Cell): any {
    if (!data?.[r]) {
        return null;
    }
    const cell = data[r][c];
    if (!cell) return undefined;
    return normalizedCellAttr(cell, attr);
}

// Polymorphic accessor: returns Cell, row, column, full matrix, or a single attr value
// depending on which of r/c are nil. Callers narrow at use.
// biome-ignore lint/suspicious/noExplicitAny: per-overload result varies (Cell | row | col | matrix | Cell[attr]); tightening forces casts at every call site
export function getCellValue(r: number, c: number, data: CellMatrix, attr?: keyof Cell): any {
    if (!attr) {
        attr = 'v';
    }

    let d_value: Cell | (Cell | null)[] | null | undefined;

    if (!isNil(r) && !isNil(c)) {
        d_value = data[r][c];
    } else if (!isNil(r)) {
        d_value = data[r];
    } else if (!isNil(c)) {
        const newData = data[0].map((_col, i) => {
            return data.map((row) => {
                return row[i];
            });
        });
        d_value = newData[c];
    } else {
        return data;
    }

    // biome-ignore lint/suspicious/noExplicitAny: same return-type union as the function
    let retv: any = d_value;

    if (isPlainObject(d_value)) {
        const d = d_value as Cell;
        retv = d[attr];

        if (attr === 'f' && !isNil(retv)) {
            retv = functionHTMLGenerate(retv);
        } else if (attr === 'f') {
            retv = (d as Cell).v;
        } else if (d?.ct && d.ct.t === 'd') {
            retv = d.m;
        }
    }

    if (retv === undefined) {
        retv = null;
    }

    return retv;
}

// `v` covers every shape callers feed in: scalar (string/number/boolean), Cell-like patch
// ({v, f, ct, …}), or null/undefined. Re-used by formula-eval, search/replace, dataVerification,
// the public API, etc. — keeping the parameter shape here is the project-wide escape hatch.
// biome-ignore lint/suspicious/noExplicitAny: cross-cutting setter, callers pass scalars and Cell-like patches indistinguishably
export function setCellValue(ctx: Context, r: number, c: number, d: CellMatrix | null | undefined, v: any) {
    if (isNil(d)) {
        d = getFlowdata(ctx);
    }
    if (!d) return;

    // If deep copy is used, cell properties during initialization are lost
    // let cell = $.extend(true, {}, d[r][c]);
    let cell = d[r][c];

    // biome-ignore lint/suspicious/noExplicitAny: tracks v's shape (scalar or cell.v from a patch)
    let vupdate: any;

    if (isPlainObject(v)) {
        if (isNil(cell)) {
            cell = v;
        } else {
            if (!isNil(v.f)) {
                cell.f = v.f;
            } else if ('f' in cell) {
                delete cell.f;
            }

            if (!isNil(v.ct)) {
                cell.ct = v.ct;
            }
        }

        if (isPlainObject(v.v)) {
            vupdate = v.v.v;
        } else {
            vupdate = v.v;
        }
    } else {
        vupdate = v;
    }

    if (isRealNull(vupdate)) {
        if (cell != null && isPlainObject(cell)) {
            delete cell.m;
            delete cell.v;
        } else {
            cell = null;
        }

        d[r][c] = cell;

        return;
    }

    // 1. Is null
    // 2. Data from pivot table, each data in flowdata might be a string, result is cell === v === a string or number data
    if (isRealNull(cell) || ((isString(cell) || isNumber(cell)) && cell === v)) {
        cell = {};
    }

    if (!cell) return;

    const vupdateStr = vupdate.toString();

    if (vupdateStr.substr(0, 1) === "'") {
        cell.m = vupdateStr.substr(1);
        cell.ct = { fa: '@', t: 's' };
        cell.v = vupdateStr.substr(1);
        cell.qp = 1;
    } else if (cell.qp === 1) {
        cell.m = vupdateStr;
        cell.ct = { fa: '@', t: 's' };
        cell.v = vupdateStr;
    } else if (vupdateStr.toUpperCase() === 'TRUE' && (isNil(cell.ct?.fa) || cell.ct?.fa !== '@')) {
        cell.m = 'TRUE';
        cell.ct = { fa: 'General', t: 'b' };
        cell.v = true;
    } else if (vupdateStr.toUpperCase() === 'FALSE' && (isNil(cell.ct?.fa) || cell.ct?.fa !== '@')) {
        cell.m = 'FALSE';
        cell.ct = { fa: 'General', t: 'b' };
        cell.v = false;
    } else if (
        vupdateStr.substr(-1) === '%' &&
        isRealNum(vupdateStr.substring(0, vupdateStr.length - 1)) &&
        (isNil(cell.ct?.fa) || cell.ct?.fa !== '@')
    ) {
        cell.ct = { fa: '0%', t: 'n' };
        cell.v = vupdateStr.substring(0, vupdateStr.length - 1) / 100;
        cell.m = vupdate;
    } else if (valueIsError(vupdate)) {
        cell.m = vupdateStr;
        // cell.ct = { "fa": "General", "t": "e" };
        if (!isNil(cell.ct)) {
            cell.ct.t = 'e';
        } else {
            cell.ct = { fa: 'General', t: 'e' };
        }
        cell.v = vupdate;
    } else {
        if (
            !isNil(cell.f) &&
            isRealNum(vupdate) &&
            !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(vupdate)
        ) {
            cell.v = parseFloat(vupdate);
            if (isNil(cell.ct)) {
                cell.ct = { fa: 'General', t: 'n' };
            }

            if (cell.v === Infinity || cell.v === -Infinity) {
                cell.m = cell.v.toString();
            } else {
                if (cell.v.toString().indexOf('e') > -1) {
                    let len: number;
                    if (cell.v.toString().split('.').length === 1) {
                        len = 0;
                    } else {
                        len = cell.v.toString().split('.')[1].split('e')[0].length;
                    }
                    if (len > 5) {
                        len = 5;
                    }

                    cell.m = cell.v.toExponential(len).toString();
                } else {
                    const v_p = Math.round(cell.v * 1000000000) / 1000000000;
                    if (isNil(cell.ct) || isNil(cell.ct.fa)) {
                        const mask = genarate(v_p);
                        if (mask != null) {
                            cell.m = mask[0].toString();
                        }
                    } else {
                        const mask = update(cell.ct.fa, v_p);
                        cell.m = mask.toString();
                    }
                }
            }
        } else if (!isNil(cell.ct) && cell.ct.fa === '@') {
            cell.m = vupdateStr;
            cell.v = vupdate;
        } else if (cell.ct != null && cell.ct.t === 'd' && isString(vupdate)) {
            const mask = genarate(vupdate);
            if (mask[1].t !== 'd' || mask[1].fa === cell.ct.fa) {
                [cell.m, cell.ct, cell.v] = mask;
            } else {
                [, , cell.v] = mask;
                cell.m = update(cell.ct.fa!, cell.v);
            }
        } else if (!isNil(cell.ct) && !isNil(cell.ct.fa) && cell.ct.fa !== 'General') {
            if (isRealNum(vupdate)) {
                vupdate = parseFloat(vupdate);
            }

            let mask: string | [string, CellType, string | number | boolean] = update(cell.ct.fa, vupdate);

            if (mask === vupdate) {
                // If the original cell format cannot be applied to the updated value, get the format of the updated value
                const newMask = genarate(vupdate);
                mask = newMask || mask;

                cell.m = typeof mask !== 'string' && mask[0] ? mask[0].toString() : '';
                if (typeof mask !== 'string' && mask.length >= 3) {
                    cell.ct = mask[1];
                    cell.v = mask[2];
                }
            } else {
                cell.m = mask.toString();
                cell.v = vupdate;
            }
        } else {
            if (
                isRealNum(vupdate) &&
                !/^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i.test(vupdate)
            ) {
                if (typeof vupdate === 'string') {
                    const flag = vupdate.split('').every((ele) => ele === '0' || ele === '.');
                    if (flag) {
                        vupdate = parseFloat(vupdate);
                    }
                }
                cell.v =
                    vupdate; /* Note: If using parseFloat, 1.1111111111111111 will be converted to 1.1111111111111112 ? */
                cell.ct = { fa: 'General', t: 'n' };
                if (cell.v === Infinity || cell.v === -Infinity) {
                    cell.m = cell.v.toString();
                } else if (cell.v != null) {
                    const mask = genarate(cell.v as string);
                    if (mask) {
                        cell.m = mask[0].toString();
                    }
                }
            } else {
                const mask = genarate(vupdate);
                if (mask) {
                    cell.m = mask[0].toString();
                    [, cell.ct, cell.v] = mask;
                }
            }
        }
    }

    // if (!server.allowUpdate && !configSettings.pointEdit) {
    //   if (
    //     !isNil(cell.ct) &&
    //     /^(w|W)((0?)|(0\.0+))$/.test(cell.ct.fa) === false &&
    //     cell.ct.t === "n" &&
    //     !isNil(cell.v) &&
    //     parseInt(cell.v, 10).toString().length > 4
    //   ) {
    //     const autoFormatw = configSettings.autoFormatw
    //       .toString()
    //       .toUpperCase();
    //     const { accuracy } = configSettings;

    //     const sfmt = setAccuracy(autoFormatw, accuracy);

    //     if (sfmt !== "General") {
    //       cell.ct.fa = sfmt;
    //       cell.m = update(sfmt, cell.v);
    //     }
    //   }
    // }

    d[r][c] = cell;
}

export function getRealCellValue(r: number, c: number, data: CellMatrix, attr?: keyof Cell) {
    let value = getCellValue(r, c, data, 'm');
    if (isNil(value)) {
        value = getCellValue(r, c, data, attr);
        if (isNil(value)) {
            const ct = getCellValue(r, c, data, 'ct');
            if (isInlineStringCT(ct)) {
                value = ct.s;
            }
        }
    }

    return value;
}

export function mergeBorder(ctx: Context, d: CellMatrix, row_index: number, col_index: number) {
    if (!d?.[row_index]) {
        return null;
    }
    const value = d[row_index][col_index];
    if (!value) return null;

    if (value?.mc) {
        const margeMaindata = value.mc;
        if (!margeMaindata) {
            return null;
        }
        col_index = margeMaindata.c;
        row_index = margeMaindata.r;

        if (isNil(d?.[row_index]?.[col_index])) {
            return null;
        }
        const col_rs = d[row_index]?.[col_index]?.mc?.cs;
        const row_rs = d[row_index]?.[col_index]?.mc?.rs;
        const mergeMain = d[row_index]?.[col_index]?.mc;

        if (!mergeMain || isNil(mergeMain?.rs) || isNil(mergeMain?.cs) || isNil(col_rs) || isNil(row_rs)) {
            return null;
        }

        let start_r: number;
        let end_r: number;
        let row: number | undefined;
        let row_pre: number | undefined;
        for (let r = row_index; r < mergeMain.rs + row_index; r += 1) {
            if (r === 0) {
                start_r = -1;
            } else {
                start_r = ctx.visibledatarow[r - 1] - 1;
            }

            end_r = ctx.visibledatarow[r];

            if (row_pre === undefined) {
                row_pre = start_r;
                row = end_r;
            } else if (row !== undefined) {
                row += end_r - start_r - 1;
            }
        }

        let start_c: number;
        let end_c: number;
        let col: number | undefined;
        let col_pre: number | undefined;

        for (let c = col_index; c < mergeMain.cs + col_index; c += 1) {
            if (c === 0) {
                start_c = 0;
            } else {
                start_c = ctx.visibledatacolumn[c - 1];
            }

            end_c = ctx.visibledatacolumn[c];

            if (col_pre === undefined) {
                col_pre = start_c;
                col = end_c;
            } else if (col !== undefined) {
                col += end_c - start_c;
            }
        }

        if (isNil(row_pre) || isNil(col_pre) || isNil(row) || isNil(col)) {
            return null;
        }

        return {
            row: [row_pre, row, row_index, row_index + row_rs - 1],
            column: [col_pre, col, col_index, col_index + col_rs - 1],
        };
    }
    return null;
}

function mergeMove(
    ctx: Context,
    mc: MergeCell,
    columnseleted: number[],
    rowseleted: number[],
    s: Partial<Selection>,
    top: number,
    height: number,
    left: number,
    width: number,
): [number[], number[], number, number, number, number] | null {
    const row_st = mc.r;
    const row_ed = mc.r + mc.rs - 1;
    const col_st = mc.c;
    const col_ed = mc.c + mc.cs - 1;
    let ismatch = false;

    columnseleted[0] = Math.min(columnseleted[0], columnseleted[1]);
    rowseleted[0] = Math.min(rowseleted[0], rowseleted[1]);

    if (
        (columnseleted[0] <= col_st &&
            columnseleted[1] >= col_ed &&
            rowseleted[0] <= row_st &&
            rowseleted[1] >= row_ed) ||
        (!(columnseleted[1] < col_st || columnseleted[0] > col_ed) &&
            !(rowseleted[1] < row_st || rowseleted[0] > row_ed))
    ) {
        const flowdata = getFlowdata(ctx);
        if (!flowdata) return null;

        const margeset = mergeBorder(ctx, flowdata, mc.r, mc.c);
        if (margeset) {
            const row = margeset.row[1];
            const row_pre = margeset.row[0];
            const col = margeset.column[1];
            const col_pre = margeset.column[0];

            if (!(columnseleted[1] < col_st || columnseleted[0] > col_ed)) {
                // Scroll up
                if (rowseleted[0] <= row_ed && rowseleted[0] >= row_st) {
                    height += top - row_pre;
                    top = row_pre;
                    rowseleted[0] = row_st;
                }

                // Scroll down or compensate upward when centering
                if (rowseleted[1] >= row_st && rowseleted[1] <= row_ed) {
                    if (s.row_focus! >= row_st && s.row_focus! <= row_ed) {
                        height = row - top;
                    } else {
                        height = row - top;
                    }

                    rowseleted[1] = row_ed;
                }
            }

            if (!(rowseleted[1] < row_st || rowseleted[0] > row_ed)) {
                if (columnseleted[0] <= col_ed && columnseleted[0] >= col_st) {
                    width += left - col_pre;
                    left = col_pre;
                    columnseleted[0] = col_st;
                }

                // Fill downward when sliding right or sliding left while centered
                if (columnseleted[1] >= col_st && columnseleted[1] <= col_ed) {
                    if (s.column_focus! >= col_st && s.column_focus! <= col_ed) {
                        width = col - left;
                    } else {
                        width = col - left;
                    }

                    columnseleted[1] = col_ed;
                }
            }

            ismatch = true;
        }
    }

    if (ismatch) {
        return [columnseleted, rowseleted, top, height, left, width];
    }
    return null;
}

export function mergeMoveMain(
    ctx: Context,
    columnseleted: number[],
    rowseleted: number[],
    s: Partial<Selection>,
    top: number,
    height: number,
    left: number,
    width: number,
): [number[], number[], number, number, number, number] | null {
    const mergesetting = ctx.config.merge;

    if (!mergesetting) {
        return null;
    }

    const mcset = Object.keys(mergesetting);

    rowseleted[1] = Math.max(rowseleted[0], rowseleted[1]);
    columnseleted[1] = Math.max(columnseleted[0], columnseleted[1]);

    let offloop = true;
    const mergeMoveData: Record<string, MergeCell> = {};

    while (offloop) {
        offloop = false;

        for (let i = 0; i < mcset.length; i += 1) {
            const key = mcset[i];
            const mc = mergesetting[key];

            if (key in mergeMoveData) {
                continue;
            }

            const changeparam = mergeMove(ctx, mc, columnseleted, rowseleted, s, top, height, left, width);

            if (changeparam != null) {
                mergeMoveData[key] = mc;

                [columnseleted, rowseleted, top, height, left, width] = changeparam;

                offloop = true;
            } else {
                delete mergeMoveData[key];
            }
        }
    }

    return [columnseleted, rowseleted, top, height, left, width];
}

export function cancelFunctionrangeSelected(ctx: Context) {
    if (ctx.formulaCache.selectingRangeIndex === -1) {
        ctx.formulaRangeSelect = undefined;
    }
}

export function cancelNormalSelected(ctx: Context) {
    cancelFunctionrangeSelected(ctx);

    ctx.editingCellPosition = [];
    ctx.formulaRangeHighlight = [];
    ctx.functionHint = null;

    ctx.formulaCache.rangestart = false;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
}

// formula.updatecell
export function updateCell(
    ctx: Context,
    r: number,
    c: number,
    $input?: HTMLDivElement | null,
    // biome-ignore lint/suspicious/noExplicitAny: forwarded straight to setCellValue, same scalar/Cell-patch union
    value?: any,
    canvas?: CanvasRenderingContext2D,
) {
    let inputText = $input?.innerText;
    const inputHtml = $input?.innerHTML;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    // Data validation: block input when the entered data is invalid
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const { dataVerification } = ctx.sheets[index];
    if (!isNil(dataVerification)) {
        const dvItem = dataVerification[`${r}_${c}`];
        if (!isNil(dvItem) && dvItem.prohibitInput && !validateCellData(ctx, dvItem, inputText)) {
            const failureText = getFailureText(ctx, dvItem);

            cancelNormalSelected(ctx);
            ctx.warnDialog = failureText;

            return;
        }
    }

    let curv = flowdata[r][c];

    // ctx.old value for hook function
    const oldValue = cloneDeep(curv);

    const isPrevInline = isInlineStringCell(curv);
    let isCurInline = inputText?.slice(0, 1) !== '=' && inputHtml?.substring(0, 5) === '<span';

    let isCopyVal = false;
    if (!isCurInline && inputText && inputText.length > 0) {
        const splitArr = inputText
            .replace(/\r\n/g, '_x000D_')
            .replace(/&#13;&#10;/g, '_x000D_')
            .replace(/\r/g, '_x000D_')
            .replace(/\n/g, '_x000D_')
            .split('_x000D_');
        if (splitArr.length > 1 && inputHtml !== '<br>') {
            isCopyVal = true;
            isCurInline = true;
            inputText = splitArr.join('\r\n');
        }
    }

    if (curv?.ct && !value && !isCurInline && isPrevInline) {
        delete curv.ct.s;
        curv.ct.t = 'g';
        curv.ct.fa = 'General';
        value = '';
    } else if (isCurInline) {
        if (!isPlainObject(curv)) {
            curv = {};
        }
        curv ||= {};
        const fontSize = curv.fs || 10;

        if (!curv.ct) {
            curv.ct = {};
            curv.ct.fa = 'General';
        }

        curv.ct.t = 'inlineStr';
        curv.ct.s = convertSpanToShareString($input!.querySelectorAll('span'), curv);
        delete curv.fs;
        delete curv.f;
        delete curv.v;
        delete curv.m;
        curv.fs = fontSize;
        if (isCopyVal) {
            curv.ct.s = [
                {
                    v: inputText,
                    fs: fontSize,
                },
            ];
        }
    }

    // API, we get value from user
    value = value || $input?.innerText;

    // Hook function
    if (ctx.hooks.beforeUpdateCell?.(r, c, value) === false) {
        cancelNormalSelected(ctx);
        return;
    }

    if (!isCurInline) {
        if (isRealNull(value) && !isPrevInline) {
            if (!curv || (isRealNull(curv.v) && !curv.f)) {
                cancelNormalSelected(ctx);
                return;
            }
        } else if (curv && curv.qp !== 1) {
            if (isPlainObject(curv) && (value === curv.f || value === curv.v || value === curv.m)) {
                cancelNormalSelected(ctx);
                return;
            }
            if (value === curv) {
                cancelNormalSelected(ctx);
                return;
            }
        }

        if (isString(value) && value.slice(0, 1) === '=' && value.length > 1) {
        } else if (isPlainObject(curv) && curv?.ct?.fa && curv.ct.fa !== '@' && !isRealNull(value)) {
            delete curv.m; // Update time m processing will actually delete the parameters of the cell data (the flowdata has been deleted)
            if (curv.f) {
                // If it turns out to be a formula but the updated data is not a formula, delete the formula.
                delete curv.f;
            }
        }
    }

    const d = flowdata;
    if (isPlainObject(curv)) {
        if (!isCurInline) {
            if (isFormula(value)) {
                const v = execfunction(ctx, value, r, c, undefined, undefined, true);
                curv = cloneDeep(d?.[r]?.[c] || {});
                [, curv.v, curv.f] = v;
            }
            // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
            else if (isPlainObject(value)) {
                const valueFunction = value.f;

                if (isFormula(valueFunction)) {
                    const v = execfunction(ctx, valueFunction, r, c, undefined, undefined, true);
                    // get v/m/ct

                    curv = cloneDeep(d?.[r]?.[c] || {});
                    [, curv.v, curv.f] = v;
                }
                // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
                else {
                    Object.keys(value).forEach((attr) => {
                        curv![attr as keyof Cell] = value[attr];
                    });
                }
            } else {
                delFunctionGroup(ctx, r, c);
                execFunctionGroup(ctx, r, c, value);

                curv = cloneDeep(d?.[r]?.[c] || {});
                curv.v = value;

                delete curv.f;

                if (curv.qp === 1 && `${value}`.substring(0, 1) !== "'") {
                    // if quotePrefix is 1, cell is force string, cell clear quotePrefix when it is updated
                    curv.qp = 0;
                    if (curv.ct) {
                        curv.ct.fa = 'General';
                        curv.ct.t = 'n';
                    }
                }
            }
        }
        value = curv;
    } else {
        if (isFormula(value)) {
            const v = execfunction(ctx, value, r, c, undefined, undefined, true);
            value = {
                v: v[1],
                f: v[2],
            };
        }
        // from API setCellValue,luckysheet.setCellValue(0, 0, {f: "=sum(D1)", bg:"#0188fb"}),value is an object, so get attribute f as value
        else if (isPlainObject(value)) {
            const valueFunction = value.f;

            if (isFormula(valueFunction)) {
                const v = execfunction(ctx, valueFunction, r, c, undefined, undefined, true);
                [, value.v, value.f] = v;
            } else {
                const v = curv;
                if (isNil(value.v)) {
                    value.v = v;
                }
            }
        } else {
            delFunctionGroup(ctx, r, c);
            execFunctionGroup(ctx, r, c, value);
        }
    }

    setCellValue(ctx, r, c, d, value);
    cancelNormalSelected(ctx);

    if ((curv?.tb === '2' && curv.v) || isInlineStringCell(d[r][c])) {
        // Word wrap
        const { defaultrowlen } = ctx;

        const cfg = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId as string) as number].config || {};
        if (!(cfg.columnlen?.[c] && cfg.rowlen?.[r])) {
            const cellWidth = cfg.columnlen?.[c] || ctx.defaultcollen;

            const textInfo = canvas
                ? getCellTextInfo(d[r][c] as Cell, canvas, ctx, {
                      r,
                      c,
                      cellWidth,
                  })
                : null;

            let currentRowLen = defaultrowlen;
            if (textInfo?.textHeightAll != null) {
                currentRowLen = textInfo.textHeightAll + 2;
            }

            if (currentRowLen > defaultrowlen && !cfg.customHeight?.[r]) {
                if (isNil(cfg.rowlen)) cfg.rowlen = {};
                cfg.rowlen[r] = currentRowLen;
            }
        }
    }

    if (ctx.hooks.afterUpdateCell) {
        const newValue = cloneDeep(flowdata[r][c]);
        const { afterUpdateCell } = ctx.hooks;
        setTimeout(() => {
            afterUpdateCell?.(r, c, oldValue, newValue);
        });
    }

    setFormulaCellInfo(ctx, { r, c, id: ctx.currentSheetId });
    ctx.formulaCache.execFunctionGlobalData = null;
}

export function getOrigincell(ctx: Context, r: number, c: number, i: string) {
    const data = getFlowdata(ctx, i);
    if (isNil(r) || isNil(c)) {
        return null;
    }

    if (!data?.[r]?.[c]) {
        return null;
    }
    return data[r][c];
}

export function getcellFormula(ctx: Context, r: number, c: number, i: string, data?: CellMatrix) {
    let cell: Cell | null;
    // `data` is a fast path for the current sheet. A calc-chain entry can belong
    // to another sheet (getAllFunctionGroup spans the whole workbook), whose rows
    // may be absent here — resolve those against their own sheet's data via `i`.
    if (isNil(data) || isNil(data[r])) {
        cell = getOrigincell(ctx, r, c, i);
    } else {
        cell = data[r][c];
    }

    if (isNil(cell)) {
        return null;
    }

    return cell.f;
}

export function getRange(ctx: Context) {
    const rangeArr = cloneDeep(ctx.selections);
    const result: Range = [];
    if (!rangeArr) return result;

    for (let i = 0; i < rangeArr.length; i += 1) {
        const rangeItem = rangeArr[i];
        const temp = {
            row: rangeItem.row,
            column: rangeItem.column,
        };
        result.push(temp);
    }
    return result;
}

export function getFlattenedRange(ctx: Context, range?: Range) {
    range = range || getRange(ctx);

    const result: { r: number; c: number }[] = [];

    range.forEach((ele) => {
        // This data may be a range or a single cell
        const rs = ele.row;
        const cs = ele.column;
        for (let r = rs[0]; r <= rs[1]; r += 1) {
            for (let c = cs[0]; c <= cs[1]; c += 1) {
                // r c: current row index and current column index
                result.push({ r, c });
            }
        }
    });
    return result;
}

function isWholeColumnRef(range: RangeOrWholeAxis): range is { row: [null, null]; column: number[] } {
    return range.row[0] === null && range.column[0] !== null;
}
function isWholeRowRef(range: RangeOrWholeAxis): range is { row: number[]; column: [null, null] } {
    return range.row[0] !== null && range.column[0] === null;
}

// Convert a selection range array to a string like A1:A2. `range.row = [null, null]`
// produces a whole-column ref (`A:A`); `range.column = [null, null]` a whole-row
// ref (`1:1`) — emitted by column-header / row-header clicks in formula-edit mode.
export function getRangetxt(ctx: Context, sheetId: string, range: RangeOrWholeAxis, currentId?: string) {
    let sheettxt = '';

    if (currentId == null) {
        currentId = ctx.currentSheetId;
    }

    if (sheetId !== currentId) {
        // If the sheet name contains ', replace it with '' when referencing
        const index = getSheetIndex(ctx, sheetId);
        if (index == null) return '';
        sheettxt = ctx.sheets[index].name.replace(/'/g, "''");
        // If the name contains characters other than a-z, A-Z, 0-9, underscore, etc., wrap it in single quotes
        if (
            // biome-ignore lint/suspicious/noMisleadingCharacterClass: matches XML 1.0 NameStartChar/NameChar — combining marks are spec-required in the continuation class
            /^[:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-zÀ-ÖØ-öø-˿Ͱ-ͽͿ-῿‌-‍⁰-↏Ⰰ-⿯、-퟿\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9·̀-ͯ‿-⁀]*$/.test(
                sheettxt,
            )
        ) {
            sheettxt += '!';
        } else {
            sheettxt = `'${sheettxt}'!`;
        }
    }

    if (isWholeColumnRef(range)) {
        return `${sheettxt + indexToColumnChar(range.column[0])}:${indexToColumnChar(range.column[1])}`;
    }
    if (isWholeRowRef(range)) {
        return `${sheettxt + (range.row[0] + 1)}:${range.row[1] + 1}`;
    }

    const { row, column } = range;
    if (column[0] === column[1] && row[0] === row[1]) {
        return sheettxt + indexToColumnChar(column[0]) + (row[0] + 1);
    }
    return `${sheettxt + indexToColumnChar(column[0]) + (row[0] + 1)}:${indexToColumnChar(column[1])}${row[1] + 1}`;
}

// Convert a string like A1:A2 to a selection range array
export function getRangeByTxt(ctx: Context, txt: string) {
    let range: (FormulaDependency | null)[] = [];
    if (txt.indexOf(',') !== -1) {
        const arr = txt.split(',');
        for (let i = 0; i < arr.length; i += 1) {
            if (iscelldata(arr[i])) {
                range.push(getcellrange(ctx, arr[i]));
            } else {
                range = [];
                break;
            }
        }
    } else {
        if (iscelldata(txt)) {
            range.push(getcellrange(ctx, txt));
        }
    }
    return range;
}

// Whether every cell in the active selection carries `status` for the given style
// attribute. Used by the toolbar to drive on/off toggles for bold / italic /
// strikethrough / underline. While an inline-string edit is active the check
// pivots to the rendered DOM and inspects each <span>'s computed style — a span
// counts as "in status" if its style[<css attr>] is non-empty.
export function isAllSelectedCellsInStatus(ctx: Context, attr: StyleAttr, status: unknown) {
    const cssField = cssDomKeyForAttr[attr];

    if (!isEmpty(ctx.editingCellPosition)) {
        const w = window.getSelection();
        if (!w) return false;
        if (w.rangeCount === 0) return false;
        const range = w.getRangeAt(0);
        if (range.collapsed === true) {
            return false;
        }
        const { endContainer } = range;
        const { startContainer } = range;
        if (startContainer === endContainer) {
            return !isEmpty(startContainer.parentElement?.style[cssField]);
        }
        if (startContainer.parentElement?.tagName === 'SPAN' && endContainer.parentElement?.tagName === 'SPAN') {
            const startSpan = startContainer.parentNode as HTMLElement | null;
            const endSpan = endContainer.parentNode as HTMLElement | null;
            const allSpans = startSpan?.parentNode?.querySelectorAll('span');
            if (allSpans) {
                const startSpanIndex = indexOf(allSpans, startSpan);
                const endSpanIndex = indexOf(allSpans, endSpan);
                const rangeSpans = [];
                for (let i = startSpanIndex; i <= endSpanIndex; i += 1) {
                    rangeSpans.push(allSpans[i]);
                }
                return every(rangeSpans, (s) => !isEmpty(s.style[cssField]));
            }
        }
    }
    /* Get all cells within the selection — processed as a flat list */
    const cells = getFlattenedRange(ctx);
    const flowdata = getFlowdata(ctx);

    return cells.every(({ r, c }) => {
        const cell = flowdata?.[r]?.[c];
        if (isNil(cell)) {
            return false;
        }
        return cell[attr] === status;
    });
}

const STYLE_KEYS = ['bl', 'it', 'ff', 'fs', 'fc', 'cl', 'un'] as const satisfies readonly StyleAttr[];

export function getFontStyleByCell(
    cell: (Cell & UnderlineHints) | null | undefined,
    checksCF?: CellFormatStyle | null,
    isCheck = true,
) {
    const style: Record<string, string> = {};
    if (!cell) {
        return style;
    }
    for (const key of STYLE_KEYS) {
        const rawValue = cell[key];
        const value: unknown = isCheck ? normalizedCellAttr(cell, key) : rawValue;
        const valueNum = Number(value);

        if (key === 'bl' && valueNum !== 0) {
            style.fontWeight = 'bold';
        }
        if (key === 'it' && valueNum !== 0) {
            style.fontStyle = 'italic';
        }
        if (key === 'ff' && typeof value === 'string' && value) {
            style.fontFamily = `'${value}', sans-serif`;
        }
        if (key === 'fs' && valueNum !== 10) {
            style.fontSize = `${valueNum}pt`;
        }
        if ((key === 'fc' && value !== '#000000') || checksCF?.textColor) {
            if (checksCF?.textColor) {
                style.color = checksCF.textColor;
            } else {
                style.color = String(value);
            }
        }
        if (key === 'cl' && valueNum !== 0) {
            style.textDecoration = 'line-through';
        }
        if (key === 'un' && (valueNum === 1 || valueNum === 3)) {
            const color = cell._color ?? cell.fc ?? '#000000';
            const fs = cell._fontSize ?? cell.fs ?? 10;
            style.borderBottom = `${Math.floor(fs / 9)}px solid ${color}`;
        }
    }
    return style;
}

export function getStyleByCell(ctx: Context, d: CellMatrix, r: number, c: number, cfCompute?: ComputeMap | null) {
    let style: Record<string, string> = {};

    // Conditional format
    const cf_compute = cfCompute ?? getComputeMap(ctx);
    const checksCF = checkCF(r, c, cf_compute);

    const cell = d?.[r]?.[c];
    if (!cell) return {};

    const isInline = isInlineStringCell(cell);
    if ('bg' in cell) {
        const value = normalizedCellAttr(cell, 'bg');
        style.background = checksCF?.cellColor ? `${checksCF.cellColor}` : `${value}`;
    }
    if ('ht' in cell) {
        const value = normalizedCellAttr(cell, 'ht');
        if (Number(value) === 0) {
            style.textAlign = 'center';
        } else if (Number(value) === 2) {
            style.textAlign = 'right';
        }
    }

    if ('vt' in cell) {
        const value = normalizedCellAttr(cell, 'vt');
        if (Number(value) === 0) {
            style.alignItems = 'center';
        } else if (Number(value) === 2) {
            style.alignItems = 'flex-end';
        }
    }
    if (!isInline) {
        style = Object.assign(style, getFontStyleByCell(cell, checksCF));
    }

    return style;
}

export function getInlineStringHTML(r: number, c: number, data: CellMatrix) {
    const ct = getCellValue(r, c, data, 'ct');
    if (isInlineStringCT(ct)) {
        const strings = ct.s;
        let value = '';
        for (let i = 0; i < strings.length; i += 1) {
            const strObj = strings[i];
            if (strObj.v) {
                const style = getFontStyleByCell(strObj);
                const styleStr = map(style, (v, key) => {
                    return `${kebabCase(key)}:${isNumber(v) ? `${v}px` : v};`;
                }).join('');
                value += `<span class="luckysheet-input-span" index='${i}' style='${styleStr}'>${strObj.v}</span>`;
            }
        }
        return value;
    }
    return '';
}

export function getQKBorder(width: string, type: string, color: string): BorderSide {
    let bordertype = '';

    if (width.toString().indexOf('pt') > -1) {
        const nWidth = parseFloat(width);

        if (nWidth < 1) {
        } else if (nWidth < 1.5) {
            bordertype = 'Medium';
        } else {
            bordertype = 'Thick';
        }
    } else {
        const nWidth = parseFloat(width);

        if (nWidth < 2) {
        } else if (nWidth < 3) {
            bordertype = 'Medium';
        } else {
            bordertype = 'Thick';
        }
    }

    let style = 0;
    type = type.toLowerCase();

    if (type === 'double') {
        style = 2;
    } else if (type === 'dotted') {
        if (bordertype === 'Medium' || bordertype === 'Thick') {
            style = 3;
        } else {
            style = 10;
        }
    } else if (type === 'dashed') {
        if (bordertype === 'Medium' || bordertype === 'Thick') {
            style = 4;
        } else {
            style = 9;
        }
    } else if (type === 'solid') {
        if (bordertype === 'Medium') {
            style = 8;
        } else if (bordertype === 'Thick') {
            style = 13;
        } else {
            style = 1;
        }
    }

    return { style, color };
}

export function getdatabyselection(ctx: Context, range: Selection | undefined, sheetId: string) {
    if (range == null && ctx.selections) {
        [range] = ctx.selections;
    }

    if (!range) return [];

    if (range.row == null || range.row.length === 0) {
        return [];
    }

    // Fetch data
    let d: CellMatrix | null | undefined;
    let cfg: SheetConfig | undefined;
    if (sheetId != null && sheetId !== ctx.currentSheetId) {
        d = ctx.sheets[getSheetIndex(ctx, sheetId)!].data;
        cfg = ctx.sheets[getSheetIndex(ctx, sheetId)!].config;
    } else {
        d = getFlowdata(ctx);
        cfg = ctx.config;
    }

    const data = [];
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        if (d?.[r] == null) {
            continue;
        }
        if (cfg?.rowhidden != null && cfg.rowhidden[r] != null) {
            continue;
        }

        const row = [];

        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            if (cfg?.colhidden != null && cfg.colhidden[c] != null) {
                continue;
            }
            row.push(d[r][c]);
        }

        data.push(row);
    }
    return data;
}

export function setEditingCell(ctx: Context, row_index: number, col_index: number) {
    ctx.editingCellPosition = [row_index, col_index];
}

export function getDataBySelectionNoCopy(ctx: Context, range: Selection) {
    if (!range?.row || range.row.length === 0) return [];
    const data = [];
    const flowData = getFlowdata(ctx);
    if (!flowData) return [];
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        const row = [];
        if (ctx.config.rowhidden != null && ctx.config.rowhidden[r] != null) {
            continue;
        }
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            let value = null;
            if (ctx.config.colhidden != null && ctx.config.colhidden[c] != null) {
                continue;
            }
            if (flowData[r] != null && flowData[r][c] != null) {
                value = flowData[r][c];
            }

            row.push(value);
        }

        data.push(row);
    }
    return data;
}
