// Autosum, from the Insert menu: on one cell it opens the editor on a sum of the numbers it finds above or to the left,
// to confirm with Enter or to change, and on a range it writes each sum straight past the range. With nothing to sum it
// opens an empty call. It runs inside a setContext recipe.

import { cellValue } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getRangetxt, setCellValue } from './cell';
import { openCellEditor } from './cell-editor';
import { rangeColor } from './color';
import { functionCallHtml, israngeseleciton } from './formula-editor';
import { computeFormula } from './formula-exec';
import { createFormulaRangeSelect, rangeSetValue } from './formula-range';
import { colLocationByIndex, rowLocationByIndex } from './location';
import { recomputeCells } from './refresh';
import { isRealNull, isRealNum } from './validation';

// A selected line of cells: a column `c`, whose blank cells sum the numbers to their left, or a row `r`, whose blank
// cells sum those above.
type Line = 'c' | 'r';

export function autoSelectionFormula(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    formula: string,
) {
    if (ctx.allowEdit === false) return;
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return;

    const openSumOfRow = (st_r: number, ed_r: number, st_c: number, ed_c: number) => {
        const start = numbersStart(flowdata, st_r, ed_c, 'c');
        if (start == null) openSum(cellInput, fxInput, ctx, st_r, st_c, null, null, formula, true);
        else openSum(cellInput, fxInput, ctx, st_r, st_c, [st_r, ed_r], [start, ed_c - 1], formula);
    };

    const openSumOfColumn = (st_r: number, ed_r: number, st_c: number, ed_c: number) => {
        const start = numbersStart(flowdata, st_c, ed_r, 'r');
        if (start == null) openSumOfRow(st_r, ed_r, st_c, ed_c);
        else openSum(cellInput, fxInput, ctx, st_r, st_c, [start, ed_r - 1], [st_c, ed_c], formula);
    };

    for (const selection of ctx.selections ?? []) {
        const [st_r, ed_r] = selection.row;
        const [st_c, ed_c] = selection.column;
        const row_index = selection.row_focus ?? st_r;
        const col_index = selection.column_focus ?? st_c;

        if (st_r === ed_r && st_c === ed_c) {
            if (ed_r === 0 && ed_c === 0) {
                openSum(cellInput, fxInput, ctx, st_r, st_c, null, null, formula, true);
            } else if (ed_r > 0 && holdsNumber(flowdata[ed_r - 1][st_c])) {
                openSumOfColumn(st_r, ed_r, st_c, ed_c);
            } else if (ed_c > 0 && holdsNumber(flowdata[st_r][ed_c - 1])) {
                openSumOfRow(st_r, ed_r, st_c, ed_c);
            } else {
                openSumOfColumn(st_r, ed_r, st_c, ed_c);
            }
        } else if (st_r === ed_r) {
            sumLine(cellInput, fxInput, ctx, flowdata, col_index, st_r, st_c, ed_c, formula, 'r');
        } else if (st_c === ed_c) {
            sumLine(cellInput, fxInput, ctx, flowdata, row_index, st_c, st_r, ed_r, formula, 'c');
        } else {
            for (let r = st_r; r <= ed_r; r += 1) {
                sumLine(cellInput, fxInput, ctx, flowdata, col_index, r, st_c, ed_c, formula, 'r', true, false);
            }
            for (let c = st_c; c <= ed_c; c += 1) {
                sumLine(cellInput, fxInput, ctx, flowdata, row_index, c, st_r, ed_r, formula, 'c', true, false);
            }
        }
    }
}

function holdsNumber(cell: Cell | null) {
    return isRealNum(cellValue(cell)) && (cell?.ct?.t == null || cell.ct.t === 'n' || cell.ct.t === 'g');
}

// A cell autosum must not write over.
function holdsValue(cell: Cell | null) {
    const v = cellValue(cell);
    return v != null && v.toString().length > 0;
}

// Where the run of numbers before `ed` starts, walking back over blanks and stopping at text.
function numbersStart(d: CellMatrix, st_x: number, ed: number, type: Line) {
    let hasValueStart = null;
    let nullNum = 0;
    let nullTime = 0;

    for (let r = ed - 1; r >= 0; r -= 1) {
        const cell = type === 'c' ? d[st_x][r] : d[r][st_x];

        if (holdsNumber(cell)) {
            hasValueStart = r;
        } else if (!holdsValue(cell)) {
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

function openSum(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    row_index: number,
    col_index: number,
    rowh: number[] | null,
    columnh: number[] | null,
    formula: string,
    noRange = false,
) {
    if (noRange) {
        const html = `${functionCallHtml(formula.toUpperCase())}<span dir="auto" class="sheet-formula-text-color">)</span>`;
        openCellEditor(ctx, row_index, col_index, { html, caret: formula.length + 2 });
        return;
    }

    if (rowh == null || columnh == null) return;
    const row_pre = rowLocationByIndex(rowh[0], ctx.visibledatarow)[0];
    const row = rowLocationByIndex(rowh[1], ctx.visibledatarow)[1];
    const col_pre = colLocationByIndex(columnh[0], ctx.visibledatacolumn)[0];
    const col = colLocationByIndex(columnh[1], ctx.visibledatacolumn)[1];

    const html = `${functionCallHtml(formula.toUpperCase())}<span class="sheet-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${rangeColor(
        0,
    )};">${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rowh, column: columnh },
        ctx.currentSheetId,
    )}</span><span dir="auto" class="sheet-formula-text-color">)</span>`;
    openCellEditor(ctx, row_index, col_index, { html });

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

function writeSum(
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
    const [v, formulaText] = computeFormula(ctx, f);
    setCellValue(ctx, r, c, d, { v, f: formulaText });
    recomputeCells(ctx, [{ r, c, id: ctx.currentSheetId }]);
}

function sumLine(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    d: CellMatrix,
    index: number,
    fix: number,
    st_m: number,
    ed_m: number,
    formula: string,
    type: Line,
    noNum = true,
    noNull = true,
) {
    const cellAt = (at: number) => (type === 'c' ? d[at][fix] : d[fix][at]);
    const write = (at: number, along: number[], across: number[]) => {
        if (type === 'c') writeSum(d, at, fix, along, across, formula, ctx);
        else writeSum(d, fix, at, across, along, formula, ctx);
    };

    let isNull = true;
    let isNum = false;
    for (let at = st_m; at <= ed_m; at += 1) {
        const cell = cellAt(at);
        if (holdsNumber(cell)) {
            isNull = false;
            isNum = true;
        } else if (!isRealNull(cellValue(cell))) {
            isNull = false;
        }
    }

    if (isNull && noNull) {
        if (numbersStart(d, index, fix, type) == null) {
            if (type === 'c') openSum(cellInput, fxInput, ctx, index, fix, null, null, formula, true);
            else openSum(cellInput, fxInput, ctx, fix, index, null, null, formula, true);
            return;
        }
        const count = ed_m - st_m + 1;
        for (let step = 0; step < count; step += 1) {
            const at = index === st_m ? st_m + step : ed_m - step;
            const start = numbersStart(d, at, fix, type);
            if (start == null) break;
            write(at, [at, at], [start, fix - 1]);
        }
        return;
    }
    if (!isNum || !noNum) return;

    // The sum lands on the first free cell past the selection, or it would read itself.
    const length = type === 'c' ? d.length : d[0].length;
    let at = ed_m + 1;
    while (holdsValue(cellAt(at))) {
        at += 1;
        if (at >= length) return;
    }
    write(at, [st_m, ed_m], [fix, fix]);
}
