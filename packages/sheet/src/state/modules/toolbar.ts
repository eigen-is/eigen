import type { BorderInfo, BorderType, RangeBorderInfo } from '@workspace/lib/sheets';
import { cloneDeep, forEach, includes, isNil, isPlainObject, pick, round, set } from 'es-toolkit/compat';
import { cfSplitRange } from '../../engine/conditional-format';
import { genarate, is_date, update } from '../../engine/format';
import type { Cell, CellMatrix, SingleRange } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { GlobalCache } from '../types';
import { getSheetIndex, isAllowEdit } from '../utils';
import { getRangetxt, isAllSelectedCellsInStatus, normalizedAttr, setCellValue } from './cell';
import { colors } from './color';
import { setFormulaCellInfo } from './formula-cache';
import { israngeseleciton } from './formula-editor';
import { execFunctionGroup, execfunction } from './formula-exec';
import { createFormulaRangeSelect, rangeSetValue, setCaretPosition } from './formula-range';
import { showLinkCard } from './hyperlink';
import {
    inlineStyleAffectAttribute,
    type StyleAttr,
    updateInlineStringFormat,
    updateInlineStringFormatOutside,
} from './inline-string';
import { colLocationByIndex, rowLocationByIndex } from './location';
import { mergeCells } from './merge';
import { normalizeSelection, selectIsOverlap } from './selection';
import { sortSelection } from './sort';
import { getCellTextInfo } from './text';
import { hasPartMC, isdatatypemulti, isRealNull, isRealNum } from './validation';

type ToolbarItemClickHandler = (ctx: Context, cellInput: HTMLDivElement, cache?: GlobalCache) => void;

type ToolbarItemSelectedFunc = (cell: Cell | null | undefined) => boolean;

export function updateFormatCell(
    ctx: Context,
    d: CellMatrix,
    attr: keyof Cell,
    foucsStatus: string | number,
    row_st: number,
    row_ed: number,
    col_st: number,
    col_ed: number,
    canvas?: CanvasRenderingContext2D,
) {
    if (isNil(d) || isNil(attr)) {
        return;
    }
    if (attr === 'ct') {
        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(ctx.config.rowhidden) && !isNil(ctx.config.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const cell = d[r][c];
                let value: string | number | boolean | null | undefined;

                if (cell != null && typeof cell === 'object') {
                    value = cell.v;
                } else {
                    value = cell as string | number | boolean | null | undefined;
                }

                if (foucsStatus !== '@' && isRealNum(value)) {
                    value = Number(value!);
                }

                const mask = update(String(foucsStatus), value);
                let type = 'n';

                if (
                    is_date(foucsStatus) ||
                    foucsStatus === 14 ||
                    foucsStatus === 15 ||
                    foucsStatus === 16 ||
                    foucsStatus === 17 ||
                    foucsStatus === 18 ||
                    foucsStatus === 19 ||
                    foucsStatus === 20 ||
                    foucsStatus === 21 ||
                    foucsStatus === 22 ||
                    foucsStatus === 45 ||
                    foucsStatus === 46 ||
                    foucsStatus === 47
                ) {
                    type = 'd';
                } else if (foucsStatus === '@' || foucsStatus === 49) {
                    type = 's';
                } else if (foucsStatus === 'General' || foucsStatus === 0) {
                    type = isRealNum(value) ? 'n' : 'g';
                }

                if (cell && isPlainObject(cell)) {
                    cell.m = `${mask}`;
                    if (isNil(cell.ct)) {
                        cell.ct = {};
                    }
                    cell.ct.fa = String(foucsStatus);
                    cell.ct.t = type;
                } else {
                    d[r][c] = {
                        ct: { fa: String(foucsStatus), t: type },
                        v: value as string,
                        m: mask,
                    };
                }
            }
        }
    } else {
        if (attr === 'ht') {
            if (foucsStatus === 'left') {
                foucsStatus = '1';
            } else if (foucsStatus === 'center') {
                foucsStatus = '0';
            } else if (foucsStatus === 'right') {
                foucsStatus = '2';
            }
        } else if (attr === 'vt') {
            if (foucsStatus === 'top') {
                foucsStatus = '1';
            } else if (foucsStatus === 'middle') {
                foucsStatus = '0';
            } else if (foucsStatus === 'bottom') {
                foucsStatus = '2';
            }
        } else if (attr === 'tb') {
            if (foucsStatus === 'overflow') {
                foucsStatus = '1';
            } else if (foucsStatus === 'clip') {
                foucsStatus = '0';
            } else if (foucsStatus === 'wrap') {
                foucsStatus = '2';
            }
        }

        const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
        if (sheetIndex == null) {
            return;
        }
        for (let r = row_st; r <= row_ed; r += 1) {
            if (!isNil(ctx.config.rowhidden) && !isNil(ctx.config.rowhidden[r])) {
                continue;
            }

            for (let c = col_st; c <= col_ed; c += 1) {
                const value = d[r][c];

                if (value && isPlainObject(value)) {
                    updateInlineStringFormatOutside(value, attr, foucsStatus);
                    (value as Record<string, unknown>)[attr as string] = foucsStatus;
                    ctx.sheets[sheetIndex].config ||= {};
                    const cfg = ctx.sheets[sheetIndex].config!;
                    const cellWidth = cfg.columnlen?.[c] || ctx.sheets[sheetIndex].defaultColWidth;
                    if (attr === 'fs' && canvas) {
                        const textInfo = getCellTextInfo(d[r][c]!, canvas, ctx, {
                            r,
                            c,
                            cellWidth,
                        });
                        if (textInfo?.textHeightAll == null) continue;
                        const rowHeight = round(textInfo.textHeightAll);
                        const currentRowHeight = cfg.rowlen?.[r] || ctx.sheets[sheetIndex].defaultRowHeight || 19;
                        if (rowHeight > currentRowHeight && cfg.customHeight?.[r] !== 1) {
                            if (cfg.rowlen === undefined) cfg.rowlen = {};
                            set(cfg, `rowlen.${r}`, rowHeight);
                        }
                    }
                } else {
                    const newCell: Cell = { v: value as Cell['v'] };
                    (newCell as Record<string, unknown>)[attr as string] = foucsStatus;
                    d[r][c] = newCell;
                }
            }
        }
    }
}

export function updateFormat(
    ctx: Context,
    $input: HTMLDivElement,
    d: CellMatrix,
    attr: keyof Cell,
    foucsStatus: string | number,
    canvas?: CanvasRenderingContext2D,
) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (attr in inlineStyleAffectAttribute) {
        if (ctx.editingCellPosition.length > 0) {
            const value = $input.innerText;
            if (value.substring(0, 1) !== '=') {
                const cell = d[ctx.editingCellPosition[0]][ctx.editingCellPosition[1]];
                if (cell) {
                    updateInlineStringFormat(ctx, cell, attr, foucsStatus, $input);
                }
                return;
            }
        }
    }

    const cfg = cloneDeep(ctx.config);
    if (isNil(cfg.rowlen)) {
        cfg.rowlen = {};
    }

    forEach(ctx.selections, (selection) => {
        const [row_st, row_ed] = selection.row;
        const [col_st, col_ed] = selection.column;

        updateFormatCell(ctx, d, attr, foucsStatus, row_st, row_ed, col_st, col_ed, canvas);
    });
}

function toggleAttr(ctx: Context, cellInput: HTMLDivElement, attr: StyleAttr) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    const flag = isAllSelectedCellsInStatus(ctx, attr, 1);
    const foucsStatus = flag ? 0 : 1;

    updateFormat(ctx, cellInput, flowdata, attr, foucsStatus);
}

function setAttr(
    ctx: Context,
    cellInput: HTMLDivElement,
    attr: keyof Cell,
    value: string | number,
    canvas?: CanvasRenderingContext2D,
) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    updateFormat(ctx, cellInput, flowdata, attr, value, canvas);
}

function checkNoNullValue(cell: Cell | null) {
    let v: Cell | Cell['v'] | null = cell;
    if (isPlainObject(v)) {
        v = (v as Cell).v;
    }

    if (
        !isRealNull(v) &&
        isdatatypemulti(v) &&
        (cell?.ct == null || cell.ct.t == null || cell.ct.t === 'n' || cell.ct.t === 'g')
    ) {
        return true;
    }

    return false;
}

function checkNoNullValueAll(cell: Cell | null) {
    let v: Cell | Cell['v'] | null = cell;
    if (isPlainObject(v)) {
        v = (v as Cell).v;
    }

    if (!isRealNull(v)) {
        return true;
    }

    return false;
}

function getNoNullValue(d: CellMatrix, st_x: number, ed: number, type: string) {
    let hasValueStart = null;
    let nullNum = 0;
    let nullTime = 0;

    for (let r = ed - 1; r >= 0; r -= 1) {
        let cell: Cell | null;
        if (type === 'c') {
            cell = d[st_x][r];
        } else {
            cell = d[r][st_x];
        }

        if (checkNoNullValue(cell)) {
            hasValueStart = r;
        } else if (cell == null || cell.v == null || cell.v === '') {
            nullNum += 1;

            if (nullNum >= 40) {
                if (nullTime <= 0) {
                    nullTime = 1;
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }

    return hasValueStart;
}

function activeFormulaInput(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    row_index: number,
    col_index: number,
    rowh: number[] | null,
    columnh: number[] | null,
    formula: string,
    cache: GlobalCache,
    isnull?: boolean,
) {
    if (isnull == null) {
        isnull = false;
    }

    ctx.editingCellPosition = [row_index, col_index];
    cache.doNotUpdateCell = true;
    if (isnull) {
        const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="luckysheet-formula-text-color">(</span><span dir="auto" class="luckysheet-formula-text-color">)</span>`;

        cellInput.innerHTML = formulaTxt;

        const spanList = cellInput.querySelectorAll('span');
        setCaretPosition(ctx, spanList[spanList.length - 2], 0, 1);

        return;
    }

    // Non-null past the `isnull` early-return: callers pass null only with isnull=true.
    if (rowh == null || columnh == null) return;
    const row_pre = rowLocationByIndex(rowh[0], ctx.visibledatarow)[0];
    const row = rowLocationByIndex(rowh[1], ctx.visibledatarow)[1];
    const col_pre = colLocationByIndex(columnh[0], ctx.visibledatacolumn)[0];
    const col = colLocationByIndex(columnh[1], ctx.visibledatacolumn)[1];

    const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${formula.toUpperCase()}</span><span dir="auto" class="luckysheet-formula-text-color">(</span><span class="fortune-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${
        colors[0]
    };">${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rowh, column: columnh },
        ctx.currentSheetId,
    )}</span><span dir="auto" class="luckysheet-formula-text-color">)</span>`;
    cellInput.innerHTML = formulaTxt;

    israngeseleciton(ctx);
    ctx.formulaCache.rangestart = true;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
    ctx.formulaCache.rangechangeindex = 0;
    rangeSetValue(ctx, cellInput, { row: rowh, column: columnh }, fxInput);
    ctx.formulaCache.func_selectedrange = {
        left: col_pre,
        width: col - col_pre - 1,
        top: row_pre,
        height: row - row_pre - 1,
        left_move: col_pre,
        width_move: col - col_pre - 1,
        top_move: row_pre,
        height_move: row - row_pre - 1,
        row: [row_index, row_index],
        column: [col_index, col_index],
    };

    createFormulaRangeSelect(ctx, {
        rangeIndex: ctx.formulaCache.rangeIndex || 0,
        left: col_pre,
        width: col - col_pre - 1,
        top: row_pre,
        height: row - row_pre - 1,
    });
}

function backFormulaInput(
    d: CellMatrix,
    r: number,
    c: number,
    rowh: number[],
    columnh: number[],
    formula: string,
    ctx: Context,
) {
    const f = `=${formula.toUpperCase()}(${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rowh, column: columnh },
        ctx.currentSheetId,
    )})`;
    const v = execfunction(ctx, f, r, c);
    const value = { v: v[1], f: v[2] };
    setCellValue(ctx, r, c, d, value);
    ctx.formulaCache.execFunctionExist ||= [];
    ctx.formulaCache.execFunctionExist.push({
        r,
        c,
        id: ctx.currentSheetId,
    });
}

function singleFormulaInput(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    d: CellMatrix,
    _index: number,
    fix: number,
    st_m: number,
    ed_m: number,
    formula: string,
    type: string,
    cache: GlobalCache,
    noNum?: boolean,
    noNull?: boolean,
) {
    if (type == null) {
        type = 'r';
    }

    if (noNum == null) {
        noNum = true;
    }

    if (noNull == null) {
        noNull = true;
    }

    let isNull = true;
    let isNum = false;

    for (let c = st_m; c <= ed_m; c += 1) {
        let cell = null;

        if (type === 'c') {
            cell = d[c][fix];
        } else {
            cell = d[fix][c];
        }

        if (checkNoNullValue(cell)) {
            isNull = false;
            isNum = true;
        } else if (checkNoNullValueAll(cell)) {
            isNull = false;
        }
    }

    if (isNull && noNull) {
        let st_r_r = getNoNullValue(d, _index, fix, type);

        if (st_r_r == null) {
            if (type === 'c') {
                activeFormulaInput(cellInput, fxInput, ctx, _index, fix, null, null, formula, cache, true);
            } else {
                activeFormulaInput(cellInput, fxInput, ctx, fix, _index, null, null, formula, cache, true);
            }
        } else {
            if (_index === st_m) {
                for (let c = st_m; c <= ed_m; c += 1) {
                    st_r_r = getNoNullValue(d, c, fix, type);

                    if (st_r_r == null) {
                        break;
                    }

                    if (type === 'c') {
                        backFormulaInput(d, c, fix, [c, c], [st_r_r, fix - 1], formula, ctx);
                    } else {
                        backFormulaInput(d, fix, c, [st_r_r, fix - 1], [c, c], formula, ctx);
                    }
                }
            } else {
                for (let c = ed_m; c >= st_m; c -= 1) {
                    st_r_r = getNoNullValue(d, c, fix, type);

                    if (st_r_r == null) {
                        break;
                    }

                    if (type === 'c') {
                        backFormulaInput(d, c, fix, [c, c], [st_r_r, fix - 1], formula, ctx);
                    } else {
                        backFormulaInput(d, fix, c, [st_r_r, fix - 1], [c, c], formula, ctx);
                    }
                }
            }
        }
        return false;
    }
    if (isNum && noNum) {
        let cell = null;

        if (type === 'c') {
            cell = d[ed_m + 1][fix];
        } else {
            cell = d[fix][ed_m + 1];
        }

        /* Note: exclude the cell itself during search to prevent a cell formula from referencing itself */
        if (cell != null && cell.v != null && cell.v.toString().length > 0) {
            let c = ed_m + 1;

            if (type === 'c') {
                cell = d[ed_m + 1][fix];
            } else {
                cell = d[fix][ed_m + 1];
            }

            while (cell != null && cell.v != null && cell.v.toString().length > 0) {
                c += 1;
                let len = null;

                if (type === 'c') {
                    len = d.length;
                } else {
                    len = d[0].length;
                }

                if (c >= len) {
                    return false;
                }

                if (type === 'c') {
                    cell = d[c][fix];
                } else {
                    cell = d[fix][c];
                }
            }

            if (type === 'c') {
                backFormulaInput(d, c, fix, [st_m, ed_m], [fix, fix], formula, ctx);
            } else {
                backFormulaInput(d, fix, c, [fix, fix], [st_m, ed_m], formula, ctx);
            }
        } else {
            if (type === 'c') {
                backFormulaInput(d, ed_m + 1, fix, [st_m, ed_m], [fix, fix], formula, ctx);
            } else {
                backFormulaInput(d, fix, ed_m + 1, [fix, fix], [st_m, ed_m], formula, ctx);
            }
        }
        return false;
    }
    return true;
}

export function autoSelectionFormula(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    formula: string,
    cache: GlobalCache,
) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return;
    let isfalse = true;
    ctx.formulaCache.execFunctionExist = [];

    function execFormulaInput_c(
        d: CellMatrix,
        st_r: number,
        ed_r: number,
        st_c: number,
        ed_c: number,
        _formula: string,
    ) {
        const st_c_c = getNoNullValue(d, st_r, ed_c, 'c');

        if (st_c_c == null) {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, null, null, _formula, cache, true);
        } else {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, [st_r, ed_r], [st_c_c, ed_c - 1], _formula, cache);
        }
    }

    function execFormulaInput(d: CellMatrix, st_r: number, ed_r: number, st_c: number, ed_c: number, _formula: string) {
        const st_r_c = getNoNullValue(d, st_c, ed_r, 'r');

        if (st_r_c == null) {
            execFormulaInput_c(d, st_r, ed_r, st_c, ed_c, _formula);
        } else {
            activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, [st_r_c, ed_r - 1], [st_c, ed_c], _formula, cache);
        }
    }

    if (!ctx.selections) return;

    forEach(ctx.selections, (selection) => {
        const [st_r, ed_r] = selection.row;
        const [st_c, ed_c] = selection.column;
        const row_index = selection.row_focus;
        const col_index = selection.column_focus;

        if (st_r === ed_r && st_c === ed_c) {
            if (ed_r - 1 < 0 && ed_c - 1 < 0) {
                activeFormulaInput(cellInput, fxInput, ctx, st_r, st_c, null, null, formula, cache, true);
                return;
            }

            if (ed_r - 1 >= 0 && checkNoNullValue(flowdata[ed_r - 1][st_c])) {
                execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
            } else if (ed_c - 1 >= 0 && checkNoNullValue(flowdata[st_r][ed_c - 1])) {
                execFormulaInput_c(flowdata, st_r, ed_r, st_c, ed_c, formula);
            } else {
                execFormulaInput(flowdata, st_r, ed_r, st_c, ed_c, formula);
            }
        } else if (st_r === ed_r) {
            isfalse = singleFormulaInput(
                cellInput,
                fxInput,
                ctx,
                flowdata,
                col_index!,
                st_r,
                st_c,
                ed_c,
                formula,
                'r',
                cache,
            );
        } else if (st_c === ed_c) {
            isfalse = singleFormulaInput(
                cellInput,
                fxInput,
                ctx,
                flowdata,
                row_index!,
                st_c,
                st_r,
                ed_r,
                formula,
                'c',
                cache,
            );
        } else {
            let r_false = true;
            for (let r = st_r; r <= ed_r; r += 1) {
                r_false =
                    singleFormulaInput(
                        cellInput,
                        fxInput,
                        ctx,
                        flowdata,
                        col_index!,
                        r,
                        st_c,
                        ed_c,
                        formula,
                        'r',
                        cache,
                        true,
                        false,
                    ) && r_false;
            }

            let c_false = true;
            for (let c = st_c; c <= ed_c; c += 1) {
                c_false =
                    singleFormulaInput(
                        cellInput,
                        fxInput,
                        ctx,
                        flowdata,
                        row_index!,
                        c,
                        st_r,
                        ed_r,
                        formula,
                        'c',
                        cache,
                        true,
                        false,
                    ) && c_false;
            }

            isfalse = !!r_false && !!c_false;
        }

        isfalse = isfalse && isfalse;
    });

    if (!isfalse) {
        ctx.formulaCache.execFunctionExist.reverse();
        ctx.formulaCache.execFunctionExist.forEach((formulaCell) => {
            setFormulaCellInfo(ctx, { r: formulaCell.r, c: formulaCell.c, id: ctx.currentSheetId }, flowdata);
        });

        execFunctionGroup(ctx, null, null, null, null, flowdata);
        ctx.formulaCache.execFunctionGlobalData = null;
    }
}

export function cancelPaintModel(ctx: Context) {
    if (ctx.copyState === null) return;
    if (ctx.copyState?.dataSheetId === ctx.currentSheetId) {
        ctx.formulaRangeSelections = [];
    } else {
        if (!ctx.copyState) return;
        const index = getSheetIndex(ctx, ctx.copyState.dataSheetId);
        if (!index) return;
        ctx.sheets[index].formulaRangeSelections = [];
    }

    ctx.copyState = {
        dataSheetId: '',
        copyRange: [{ row: [0], column: [0] }],
        RowlChange: false,
        HasMC: false,
    };

    ctx.formatPainterOn = false;
}

export function handleNumberFormat(ctx: Context, cellInput: HTMLDivElement, pattern: string) {
    setAttr(ctx, cellInput, 'ct', pattern);
}

export function handleCurrencyFormat(ctx: Context, cellInput: HTMLDivElement) {
    const currency = ctx.currency || '€';

    handleNumberFormat(ctx, cellInput, `${currency} #.00`);
}

export function handlePercentageFormat(ctx: Context, cellInput: HTMLDivElement) {
    handleNumberFormat(ctx, cellInput, '0.00%');
}

export function handleNumberDecrease(ctx: Context, cellInput: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata || !ctx.selections) return;

    const row_index = ctx.selections[0].row_focus;
    const col_index = ctx.selections[0].column_focus;
    if (row_index === undefined || col_index === undefined) return;

    let foucsStatus = normalizedAttr(flowdata, row_index, col_index, 'ct');
    const cell = flowdata[row_index][col_index];

    if (foucsStatus == null || foucsStatus.t !== 'n') {
        return;
    }

    if (foucsStatus.fa === 'General') {
        if (!cell?.v) return;

        [, foucsStatus] = genarate(cell.v);
    }

    // Wan/Yi (10,000/100,000,000) number format
    const reg = /^(w|W)((0?)|(0\.0+))$/;
    if (reg.test(foucsStatus.fa)) {
        if (foucsStatus.fa.includes('.')) {
            if (foucsStatus.fa.substr(-2) === '.0') {
                updateFormat(ctx, cellInput, flowdata, 'ct', foucsStatus.fa.split('.')[0]);
            } else {
                updateFormat(ctx, cellInput, flowdata, 'ct', foucsStatus.fa.substr(0, foucsStatus.fa.length - 1));
            }
        } else {
            updateFormat(ctx, cellInput, flowdata, 'ct', foucsStatus.fa);
        }

        return;
    }
    let prefix = '';
    let main = '';
    let fa = [];
    if (foucsStatus.fa.includes('.')) {
        fa = foucsStatus.fa.split('.');
        [prefix, main] = fa;
    } else {
        return;
    }

    fa = main.split('');
    let tail = '';
    for (let i = fa.length - 1; i >= 0; i -= 1) {
        const c = fa[i];
        if (c !== '#' && c !== '0' && c !== ',' && Number.isNaN(parseInt(c, 10))) {
            tail = c + tail;
        } else {
            break;
        }
    }

    let fmt = '';
    if (foucsStatus.fa.includes('.')) {
        let suffix = main;
        if (tail.length > 0) {
            suffix = main.replace(tail, '');
        }

        let pos = suffix.replace(/#/g, '0');
        pos = pos.substr(0, pos.length - 1);
        if (pos === '') {
            fmt = prefix + tail;
        } else {
            fmt = `${prefix}.${pos}${tail}`;
        }
    }

    updateFormat(ctx, cellInput, flowdata, 'ct', fmt);
}

export function handleNumberIncrease(ctx: Context, cellInput: HTMLDivElement) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;
    if (!ctx.selections) return;
    const row_index = ctx.selections[0].row_focus;
    const col_index = ctx.selections[0].column_focus;
    if (row_index === undefined || col_index === undefined) return;
    let foucsStatus = normalizedAttr(flowdata, row_index, col_index, 'ct');
    const cell = flowdata[row_index][col_index];

    if (foucsStatus == null || foucsStatus.t !== 'n') {
        return;
    }

    if (foucsStatus.fa === 'General') {
        if (!cell?.v) return;
        [, foucsStatus] = genarate(cell.v);
    }

    if (foucsStatus.fa === 'General') {
        updateFormat(ctx, cellInput, flowdata, 'ct', '#.0');
        return;
    }

    // Wan/Yi (10,000/100,000,000) number format
    const reg = /^(w|W)((0?)|(0\.0+))$/;
    if (reg.test(foucsStatus.fa)) {
        if (foucsStatus.fa.includes('.')) {
            updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}0`);
        } else {
            if (foucsStatus.fa.substr(-1) === '0') {
                updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}.0`);
            } else {
                updateFormat(ctx, cellInput, flowdata, 'ct', `${foucsStatus.fa}0.0`);
            }
        }

        return;
    }

    let prefix = '';
    let main = '';
    let fa = [];

    if (foucsStatus.fa.includes('.')) {
        fa = foucsStatus.fa.split('.');
        [prefix, main] = fa;
    } else {
        main = foucsStatus.fa;
    }

    fa = main.split('');
    let tail = '';
    for (let i = fa.length - 1; i >= 0; i -= 1) {
        const c = fa[i];
        if (c !== '#' && c !== '0' && c !== ',' && Number.isNaN(parseInt(c, 10))) {
            tail = c + tail;
        } else {
            break;
        }
    }

    let fmt = '';
    if (foucsStatus.fa.includes('.')) {
        let suffix = main;
        if (tail.length > 0) {
            suffix = main.replace(tail, '');
        }

        let pos = suffix.replace(/#/g, '0');
        pos += '0';
        fmt = `${prefix}.${pos}${tail}`;
    } else {
        if (tail.length > 0) {
            fmt = `${main.replace(tail, '')}.0${tail}`;
        } else {
            fmt = `${main}.0${tail}`;
        }
    }

    updateFormat(ctx, cellInput, flowdata, 'ct', fmt);
}

export function handleBold(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'bl');
}

export function handleItalic(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'it');
}

export function handleFont(ctx: Context, cellInput: HTMLDivElement, fontName: string) {
    setAttr(ctx, cellInput, 'ff', fontName);
}

export function handleStrikeThrough(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'cl');
}

export function handleUnderline(ctx: Context, cellInput: HTMLDivElement) {
    toggleAttr(ctx, cellInput, 'un');
}

export function handleHorizontalAlign(ctx: Context, cellInput: HTMLDivElement, value: string) {
    setAttr(ctx, cellInput, 'ht', value);
}

export function handleVerticalAlign(ctx: Context, cellInput: HTMLDivElement, value: string) {
    setAttr(ctx, cellInput, 'vt', value);
}

export function handleFormatPainter(ctx: Context) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    if (ctx.selections == null || ctx.selections.length === 0) {
        return;
    }
    if (ctx.selections.length > 1) {
        return;
    }

    // *Added a check for whether the selection contains partial merged cells; if so, block the next step of format painter
    // TODO Could also be changed to: when a partial merge is detected, delete the mc value of range cells after format painter pastes the format

    let has_PartMC = false;

    const r1 = ctx.selections[0].row[0];
    const r2 = ctx.selections[0].row[1];

    const c1 = ctx.selections[0].column[0];
    const c2 = ctx.selections[0].column[1];

    has_PartMC = hasPartMC(ctx, r1, r2, c1, c2);

    if (has_PartMC) {
        return;
    }

    cancelPaintModel(ctx);

    ctx.formulaRangeSelections = [
        {
            row: ctx.selections[0].row,
            column: ctx.selections[0].column,
        },
    ];

    let RowlChange = false;
    let HasMC = false;

    for (let r = ctx.selections[0].row[0]; r <= ctx.selections[0].row[1]; r += 1) {
        if (ctx.config.rowhidden != null && ctx.config.rowhidden[r] != null) {
            continue;
        }

        if (ctx.config.rowlen != null && r in ctx.config.rowlen) {
            RowlChange = true;
        }

        for (let c = ctx.selections[0].column[0]; c <= ctx.selections[0].column[1]; c += 1) {
            const flowdata = getFlowdata(ctx);
            if (!flowdata) return;
            const cell = flowdata[r][c];
            if (cell != null && cell.mc != null && cell.mc.rs != null) {
                HasMC = true;
            }
        }
    }
    ctx.copyState = {
        dataSheetId: ctx.currentSheetId,
        copyRange: [
            {
                row: ctx.selections[0].row,
                column: ctx.selections[0].column,
            },
        ],
        RowlChange,
        HasMC,
    };

    ctx.formatPainterOn = true;
    ctx.formatPainterOnce = true;
}

// 2022-10-10 Replaced the forEach loop in handleClearFormat with an every loop that can break early, to prevent a selection from being processed multiple times
export function handleClearFormat(ctx: Context) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;
    ctx.selections?.every((selection) => {
        const [rowSt, rowEd] = selection.row;
        const [colSt, colEd] = selection.column;
        for (let r = rowSt; r <= rowEd; r += 1) {
            if (!isNil(ctx.config.rowhidden) && !isNil(ctx.config.rowhidden[r])) {
                continue;
            }
            for (let c = colSt; c <= colEd; c += 1) {
                const cell = flowdata[r][c];
                if (!cell) continue;
                flowdata[r][c] = pick(cell, 'v', 'm', 'mc', 'f', 'ct');
            }
        }
        // When clearing table styles, also clear border styles
        const index = getSheetIndex(ctx, ctx.currentSheetId);
        if (index == null) return false;
        // If there are no border styles, skip table operations
        if (ctx.config.borderInfo == null) return false;
        const cfg = ctx.config || {};
        if (cfg.borderInfo && cfg.borderInfo.length > 0) {
            const source_borderInfo: BorderInfo[] = [];

            for (let i = 0; i < cfg.borderInfo.length; i += 1) {
                const entry = cfg.borderInfo[i];

                if (entry.rangeType === 'range' && entry.borderType !== 'border-slash') {
                    const bd_emptyRange: SingleRange[] = [];

                    for (let j = 0; j < entry.range.length; j += 1) {
                        bd_emptyRange.push(
                            ...cfSplitRange(
                                entry.range[j],
                                { row: [rowSt, rowEd], column: [colSt, colEd] },
                                { row: [rowSt, rowEd], column: [colSt, colEd] },
                                'restPart',
                            ),
                        );
                    }

                    entry.range = bd_emptyRange;
                    source_borderInfo.push(entry);
                } else if (entry.rangeType === 'cell') {
                    const bd_r = entry.value.row_index;
                    const bd_c = entry.value.col_index;

                    if (!(bd_r >= rowSt && bd_r <= rowEd && bd_c >= colSt && bd_c <= colEd)) {
                        source_borderInfo.push(entry);
                    }
                } else if (
                    !(
                        entry.range[0].row[0] >= rowSt &&
                        entry.range[0].row[0] <= rowEd &&
                        entry.range[0].column[0] >= colSt &&
                        entry.range[0].column[0] <= colEd
                    )
                ) {
                    // remaining slash range entries that fall outside the clear rect
                    source_borderInfo.push(entry);
                }
            }

            ctx.sheets[index].config!.borderInfo = source_borderInfo;
        }
        return true;
    });
}

export function handleTextColor(ctx: Context, cellInput: HTMLDivElement, color: string) {
    setAttr(ctx, cellInput, 'fc', color);
}

export function handleTextBackground(ctx: Context, cellInput: HTMLDivElement, color: string) {
    setAttr(ctx, cellInput, 'bg', color);
}

export function handleBorder(ctx: Context, type: BorderType, borderColor?: string, borderStyle?: string) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    const color = borderColor == null || borderColor === '' ? '#000' : borderColor;
    const style = borderStyle == null || borderStyle === '' ? '1' : borderStyle;

    const cfg = ctx.config;
    if (cfg.borderInfo == null) {
        cfg.borderInfo = [];
    }

    if (type !== 'border-slash') {
        const borderInfo: RangeBorderInfo = {
            rangeType: 'range',
            borderType: type,
            color,
            style,
            range: cloneDeep(ctx.selections) || [],
        };
        cfg.borderInfo.push(borderInfo);
    } else {
        const rangeList: string[] = [];
        forEach(ctx.selections, (selection) => {
            for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
                for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
                    const range = `${r}_${c}`;
                    if (includes(rangeList, range)) continue;
                    const borderInfo: RangeBorderInfo = {
                        rangeType: 'range',
                        borderType: type,
                        color,
                        style,
                        range: normalizeSelection(ctx, [{ row: [r, r], column: [c, c] }]),
                    };
                    cfg.borderInfo!.push(borderInfo);
                    rangeList.push(range);
                }
            }
        });
    }

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;

    ctx.sheets[index].config = ctx.config;
}

export function handleMerge(ctx: Context, type: string) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    if (selectIsOverlap(ctx)) {
        return;
    }

    if (ctx.config.merge != null) {
        let has_PartMC = false;
        if (!ctx.selections) return;
        for (let s = 0; s < ctx.selections.length; s += 1) {
            const r1 = ctx.selections[s].row[0];
            const r2 = ctx.selections[s].row[1];
            const c1 = ctx.selections[s].column[0];
            const c2 = ctx.selections[s].column[1];

            has_PartMC = hasPartMC(ctx, r1, r2, c1, c2);

            if (has_PartMC) {
                break;
            }
        }

        if (has_PartMC) {
            return;
        }
    }

    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (!ctx.selections) return;

    mergeCells(ctx, ctx.currentSheetId, ctx.selections, type);
}

export function handleSort(ctx: Context, isAsc: boolean) {
    sortSelection(ctx, isAsc);
}

export function handleFreeze(ctx: Context, type: string) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    const file = ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId)!];
    if (!file) return;

    if (type === 'freeze-cancel') {
        delete file.frozen;
        return;
    }

    const firstSelection = ctx.selections?.[0];
    if (!firstSelection) return;

    let { row_focus, column_focus } = firstSelection;
    if (row_focus == null || column_focus == null) return;

    const m = ctx.config.merge?.[`${row_focus}_${column_focus}`];
    if (m) {
        row_focus = m.r + m.rs - 1;
        column_focus = m.c + m.cs - 1;
    }

    file.frozen = { type: 'both', range: { row_focus, column_focus } };
    if (type === 'freeze-row') {
        file.frozen.type = 'rangeRow';
    } else if (type === 'freeze-col') {
        file.frozen.type = 'rangeColumn';
    }
}

export function handleTextSize(
    ctx: Context,
    cellInput: HTMLDivElement,
    size: number,
    canvas?: CanvasRenderingContext2D,
) {
    setAttr(ctx, cellInput, 'fs', size, canvas);
}

export function handleSum(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    cache?: GlobalCache,
) {
    autoSelectionFormula(ctx, cellInput, fxInput, 'SUM', cache!);
}

export function handleLink(ctx: Context) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    const selection = ctx.selections?.[0];
    const flowdata = getFlowdata(ctx);
    if (flowdata != null && selection != null) {
        showLinkCard(ctx, selection.row[0], selection.column[0], true);
    }
}

const handlerMap: Record<string, ToolbarItemClickHandler> = {
    'currency-format': handleCurrencyFormat,
    'percentage-format': handlePercentageFormat,
    'number-decrease': handleNumberDecrease,
    'number-increase': handleNumberIncrease,
    'sort-cell': (ctx: Context) => handleSort(ctx, true),
    'merge-all': (ctx: Context) => handleMerge(ctx, 'mergeAll'),
    'border-all': (ctx: Context) => handleBorder(ctx, 'border-all'),
    bold: handleBold,
    italic: handleItalic,
    'strike-through': handleStrikeThrough,
    underline: handleUnderline,
    'clear-format': handleClearFormat,
    'format-painter': handleFormatPainter,
    link: handleLink,
};

const selectedMap: Record<string, ToolbarItemSelectedFunc> = {
    bold: (cell) => cell?.bl === 1,
    italic: (cell) => cell?.it === 1,
    'strike-through': (cell) => cell?.cl === 1,
    underline: (cell) => cell?.un === 1,
};

export function toolbarItemClickHandler(name: string) {
    return handlerMap[name];
}

export function toolbarItemSelectedFunc(name: string) {
    return selectedMap[name];
}
