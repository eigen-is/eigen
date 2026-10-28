// Reads and writes of single cells in the open sheet, such as a cell's value, its display text and the
// CSS the editor box shows it in. updateCell commits the cell editor or the formula bar into the matrix:
// it runs the formula engine, data validation and the row's auto height. Range helpers that read cells,
// such as getRangeByTxt, live here too.

import type { BorderSide, MergeCell } from '@workspace/lib/sheets';
import { columnIndexToLabel, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { cloneDeep, isNil, isNumber, isPlainObject, isString } from 'es-toolkit/compat';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import {
    booleanDisplay,
    cellWrapsText,
    dropRuns,
    generalAlign,
    numberDisplay,
    parseCellInput,
    richText,
} from '../../engine/format';
import { isFormula } from '../../engine/formula-engine';
import { iscelldata } from '../../engine/formula-utils';
import type { Cell, CellMatrix, FormulaDependency } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { Range, RangeOrWholeAxis, Selection } from '../types';
import { getSheetIndex, rgbToHex } from '../utils';
import { checkCF, getComputeMap } from './condition-format';
import { describeValidationRule, validateCellData } from './data-verification';
import { setFormulaCellInfo } from './formula-cache';
import { functionHTMLGenerate } from './formula-editor';
import { delFunctionGroup, execFunctionGroup, execfunction, getcellrange } from './formula-exec';
import type { RunStyleKey } from './inline-string';
import {
    committedRuns,
    cssFontName,
    DEFAULT_TEXT_COLOR,
    hexColor,
    isInlineStringCell,
    runStyleOf,
    runsHtml,
    sameRunStyle,
} from './inline-string';
import { getCellTextInfo } from './text';
import { ID_CARD_NUMBER, isPlainNumber, isRealNull, isRealNum, valueIsError } from './validation';

// Returns the cell attribute value, normalized to a default when missing. Result is a
// value-space union (string for color/format/alignment, number for fs, CellType for ct, …);
// callers narrow at use, e.g. `Number(value)` or `String(value)` per attr.
// biome-ignore lint/suspicious/noExplicitAny: per-attr return shape varies (string default vs Cell[attr]); tightening forces casts at every call site
export function normalizedCellAttr(cell: Cell, attr: keyof Cell): any {
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
        const defaultValue = attr === 'ht' ? generalAlign(cell) : '0';
        value = !isNil(value) ? value.toString() : defaultValue;
        if (['0', '1', '2'].indexOf(value.toString()) === -1) {
            value = defaultValue;
        }
    } else if (attr === 'fs') {
        value ||= String(SHEET_DEFAULT_FONT_SIZE);
    } else if (attr === 'tb') {
        // Text overflows unless set to clip ('0') or wrap ('2'), as in Google Sheets and Excel.
        value ||= '1';
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

        if (d?.ct && d.ct.t === 'd') {
            retv = d.m;
        } else if (attr === 'v' || attr === 'm') {
            retv = richText(d) ?? retv;
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

    // A deep copy would lose the cell properties set at initialization.
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

    // A rich write, runs with no value or formula, brings its runs; any other write drops the cell's.
    if (cell != null && !(isPlainObject(v) && isNil(v.f) && isRealNull(vupdate) && richText(v) !== undefined)) {
        dropRuns(cell);
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

    // A formula's text result stays text however it reads (=TEXT(5,"000") is "005"), as recalc stores it.
    if (!isNil(cell.f) && isString(vupdate) && !valueIsError(vupdate)) {
        cell.v = vupdate;
        cell.m = vupdate;
        cell.ct ??= { fa: 'General', t: 'g' };
    } else if (vupdateStr.substr(0, 1) === "'") {
        cell.m = vupdateStr.substr(1);
        cell.ct = { fa: '@', t: 's' };
        cell.v = vupdateStr.substr(1);
        cell.qp = 1;
    } else if (cell.qp === 1) {
        cell.m = vupdateStr;
        cell.ct = { fa: '@', t: 's' };
        cell.v = vupdateStr;
    } else if (vupdateStr.toUpperCase() === 'TRUE' && (isNil(cell.ct?.fa) || cell.ct?.fa !== '@')) {
        cell.m = booleanDisplay(true);
        cell.ct = { fa: 'General', t: 'b' };
        cell.v = true;
    } else if (vupdateStr.toUpperCase() === 'FALSE' && (isNil(cell.ct?.fa) || cell.ct?.fa !== '@')) {
        cell.m = booleanDisplay(false);
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
    } else if (valueIsError(vupdate) && (!isNil(cell.f) || cell.ct?.fa !== '@')) {
        // Typed into a text-formatted cell, an error is text, as in Excel. A formula's error is an error in any format.
        cell.m = vupdateStr;
        if (!isNil(cell.ct)) {
            cell.ct.t = 'e';
        } else {
            cell.ct = { fa: 'General', t: 'e' };
        }
        cell.v = vupdate;
    } else {
        if (!isNil(cell.f) && isPlainNumber(vupdate) && !ID_CARD_NUMBER.test(vupdateStr)) {
            cell.v = Number(vupdate);
            if (isNil(cell.ct)) {
                cell.ct = { fa: 'General', t: 'n' };
            }

            cell.m = numberDisplay(cell.v, cell.ct.fa);
        } else if (!isNil(cell.ct) && cell.ct.fa === '@') {
            cell.m = vupdateStr;
            cell.v = vupdate;
        } else if (cell.ct != null && cell.ct.t === 'd' && isString(vupdate)) {
            const mask = parseCellInput(vupdate);
            if (mask[1].t !== 'd' || mask[1].fa === cell.ct.fa) {
                [cell.m, cell.ct, cell.v] = mask;
            } else {
                [, , cell.v] = mask;
                cell.m = numberDisplay(cell.v, cell.ct.fa);
            }
        } else if (!isNil(cell.ct) && !isNil(cell.ct.fa) && cell.ct.fa !== 'General') {
            if (isPlainNumber(vupdate)) {
                vupdate = Number(vupdate);
            }

            const mask = numberDisplay(vupdate, cell.ct.fa);

            if (mask === vupdate) {
                // If the original cell format cannot be applied to the updated value, get the format of the updated value
                [cell.m, cell.ct, cell.v] = parseCellInput(vupdate);
            } else {
                cell.m = mask;
                cell.v = vupdate;
            }
        } else {
            if (isPlainNumber(vupdate) && !ID_CARD_NUMBER.test(vupdateStr)) {
                cell.v = Number(vupdate);
                cell.ct = { fa: 'General', t: 'n' };
                cell.m = numberDisplay(cell.v);
            } else {
                [cell.m, cell.ct, cell.v] = parseCellInput(vupdate);
            }
        }
    }

    d[r][c] = cell;
}

export function getRealCellValue(r: number, c: number, data: CellMatrix, attr?: keyof Cell) {
    const value = getCellValue(r, c, data, 'm');
    return isNil(value) ? getCellValue(r, c, data, attr) : value;
}

// A number stored as text (qp === 1) that still reads as a number. The painter marks it with a
// green corner triangle; the glyph hit-test claims that same corner. One predicate so the two
// never drift over what "forced string" means.
export function isForcedStringNumber(cell: Cell | null | undefined): boolean {
    return cell?.qp === 1 && !Number.isNaN(Number(cell.v));
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
                    height = row - top;

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
                    width = col - left;

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
    top: number,
    height: number,
    left: number,
    width: number,
): [number[], number[], number, number, number, number] | null {
    const mergesetting = getSheetConfig(ctx)?.merge;

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

            const changeparam = mergeMove(ctx, mc, columnseleted, rowseleted, top, height, left, width);

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
    const inputText = $input?.innerText;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    // Data validation: block input when the entered data is invalid
    const sheet = getSheet(ctx);
    const { dataVerification } = sheet;
    if (!isNil(dataVerification)) {
        const dvItem = dataVerification[`${r}_${c}`];
        if (!isNil(dvItem) && dvItem.prohibitInput && !validateCellData(ctx, dvItem, inputText)) {
            cancelNormalSelected(ctx);
            ctx.warnDialog = describeValidationRule(dvItem, 'invalid');

            return;
        }
    }

    let curv = flowdata[r][c];

    const isPrevInline = isInlineStringCell(curv);
    // Typed text is rich when its runs differ from the cell's own style or break the line. Text that is
    // all in the cell's style commits plain, as a formula always does.
    const runs = $input && !value && inputText?.slice(0, 1) !== '=' ? committedRuns($input, curv) : [];
    const isCurInline =
        runs.length > 1 ||
        runs.some((run) => run.v.includes('\n')) ||
        (runs.length === 1 && !sameRunStyle(runs[0], runStyleOf(curv)));

    if (curv?.ct && !value && !isCurInline && isPrevInline) {
        delete curv.ct.s;
        curv.ct.t = 'g';
        curv.ct.fa = 'General';
        value = '';
    } else if (isCurInline) {
        curv = isPlainObject(curv) && curv ? curv : {};
        curv.ct = { ...curv.ct, fa: curv.ct?.fa ?? 'General', t: 'inlineStr', s: runs };
        delete curv.f;
        delete curv.v;
        delete curv.m;
        curv.fs ||= SHEET_DEFAULT_FONT_SIZE;
    }

    // API, we get value from user
    value = value || (runs.length === 1 && !isCurInline ? runs[0].v : $input?.innerText);

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
    if (curv && isPlainObject(curv)) {
        if (!isCurInline) {
            if (isFormula(value)) {
                const v = execfunction(ctx, value, r, c, undefined, undefined, true);
                curv = cloneDeep(d?.[r]?.[c] || {});
                [, curv.v, curv.f] = v;
            }
            // A cell object, such as setCellValue(0, 0, { f: '=SUM(D1)', bg: '#0188fb' }), carries its formula in `f`.
            else if (isPlainObject(value)) {
                const valueFunction = value.f;

                if (isFormula(valueFunction)) {
                    const v = execfunction(ctx, valueFunction, r, c, undefined, undefined, true);
                    // get v/m/ct

                    curv = cloneDeep(d?.[r]?.[c] || {});
                    [, curv.v, curv.f] = v;
                }
                // A cell object without a formula: its fields are copied onto the cell.
                else {
                    for (const attr of Object.keys(value)) {
                        curv[attr as keyof Cell] = value[attr];
                    }
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
        } else {
            // A rich edit's dependents read its runs, as a plain edit's read its value.
            delFunctionGroup(ctx, r, c);
            execFunctionGroup(ctx, r, c, curv);
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
        // A cell object, such as setCellValue(0, 0, { f: '=SUM(D1)', bg: '#0188fb' }), carries its formula in `f`.
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

    const written = d[r][c];
    if (written && ((cellWrapsText(written) && written.v) || isInlineStringCell(written))) {
        const { defaultrowlen } = ctx;

        const cfg = (sheet.config ??= {});
        if (!(cfg.columnlen?.[c] && cfg.rowlen?.[r])) {
            const cellWidth = cfg.columnlen?.[c] || ctx.defaultcollen;

            const textInfo = canvas
                ? getCellTextInfo(written, canvas, {
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

    for (const ele of range) {
        // This data may be a range or a single cell
        const rs = ele.row;
        const cs = ele.column;
        for (let r = rs[0]; r <= rs[1]; r += 1) {
            for (let c = cs[0]; c <= cs[1]; c += 1) {
                // r c: current row index and current column index
                result.push({ r, c });
            }
        }
    }
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
        return `${sheettxt + columnIndexToLabel(range.column[0])}:${columnIndexToLabel(range.column[1])}`;
    }
    if (isWholeRowRef(range)) {
        return `${sheettxt + (range.row[0] + 1)}:${range.row[1] + 1}`;
    }

    const { row, column } = range;
    if (column[0] === column[1] && row[0] === row[1]) {
        return sheettxt + columnIndexToLabel(column[0]) + (row[0] + 1);
    }
    return `${sheettxt + columnIndexToLabel(column[0]) + (row[0] + 1)}:${columnIndexToLabel(column[1])}${row[1] + 1}`;
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

// Whether every cell in the active selection has `status` for a style key, which decides whether a
// toolbar toggle such as Bold turns the key on or off. The open cell editor decides it from its own
// runs instead (editorSelectionStyle).
export function isAllSelectedCellsInStatus(ctx: Context, attr: RunStyleKey, status: unknown) {
    const flowdata = getFlowdata(ctx);
    return getFlattenedRange(ctx).every(({ r, c }) => {
        const cell = flowdata?.[r]?.[c];
        return !isNil(cell) && cell[attr] === status;
    });
}

// The font part of a cell's CSS, for the editor box and the copied HTML. Only the keys the cell sets
// write CSS, so the box inherits the rest. The cell is read as its runs are, so a legacy string flag or
// size reads as its number, the box and the runs typed in it agree, and a color or font that is not a
// plain value writes no CSS.
export function getFontStyleByCell(cell: Cell | null | undefined, checksCF?: CellFormatStyle | null) {
    const style: Record<string, string> = {};
    if (!cell) {
        return style;
    }
    const { bl, it, cl, fs, fc } = runStyleOf(cell);
    if (bl) style.fontWeight = 'bold';
    if (it) style.fontStyle = 'italic';
    const font = cssFontName(cell.ff);
    if (font) style.fontFamily = `'${font}', sans-serif`;
    if (fs !== SHEET_DEFAULT_FONT_SIZE) style.fontSize = `${fs}pt`;
    const color = hexColor(checksCF?.textColor) ?? fc;
    if (color !== DEFAULT_TEXT_COLOR) style.color = color;
    if (cl) style.textDecoration = 'line-through';
    const underline = Number(cell.un);
    if (underline === 1 || underline === 3) style.borderBottom = `${Math.floor(fs / 9)}px solid ${color}`;
    return style;
}

export function getStyleByCell(ctx: Context, d: CellMatrix, r: number, c: number, cfCompute?: ComputeMap | null) {
    const style: Record<string, string> = {};

    // Conditional format
    const cf_compute = cfCompute ?? getComputeMap(ctx);
    const checksCF = checkCF(r, c, cf_compute);

    const cell = d?.[r]?.[c];
    if (!cell) return {};

    const background = hexColor(checksCF?.cellColor) ?? hexColor(cell.bg);
    if (background) style.background = background;
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
    // A rich cell's box shows its own style too: its spans state only where a run differs from it.
    return Object.assign(style, getFontStyleByCell(cell, checksCF));
}

// A formula is shown in the formula bar and the in-cell editor as colored spans, not as
// text — the reference tokens have to be clickable and highlightable. Returns null when
// the cell carries no formula, so the caller applies its own fallback: the two editors
// disagree about rich text (the bar shows it plain, the cell shows it styled), so that
// rule belongs to them, not here.
//
// This lives apart from getCellValue on purpose. Generating the markup inside the getter
// meant `getCellValue(r, c, data, 'f')` returned HTML rather than the formula, which read
// as a plain attribute read at every callsite and cost us a shipped regression: an
// escaping pass wrapped it in escapeHtml and printed the markup at the user.
export function getFormulaHtml(r: number, c: number, data: CellMatrix): string | null {
    const f = getCellValue(r, c, data, 'f');
    return isNil(f) ? null : functionHTMLGenerate(String(f));
}

// A rich cell's runs as the spans the in-cell editor opens with. The text and the CSS are escaped: both
// come from the cell, which any collaborator or an uploaded xlsx wrote.
export function getInlineStringHTML(r: number, c: number, data: CellMatrix) {
    const cell = data[r]?.[c];
    return isInlineStringCell(cell) ? runsHtml(cell.ct.s, runStyleOf(cell)) : '';
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
    const d = getFlowdata(ctx, sheetId);
    const cfg = getSheetConfig(ctx, sheetId);

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
    const cfg = getSheetConfig(ctx);
    for (let r = range.row[0]; r <= range.row[1]; r += 1) {
        const row = [];
        if (cfg?.rowhidden?.[r] != null) {
            continue;
        }
        for (let c = range.column[0]; c <= range.column[1]; c += 1) {
            let value = null;
            if (cfg?.colhidden?.[c] != null) {
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
