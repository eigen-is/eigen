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

    const openSumOfRow = (top: number, bottom: number, left: number, right: number) => {
        const start = numbersStart(flowdata, top, right, 'c');
        if (start == null) openSum(cellInput, fxInput, ctx, top, left, null, null, formula, true);
        else openSum(cellInput, fxInput, ctx, top, left, [top, bottom], [start, right - 1], formula);
    };

    const openSumOfColumn = (top: number, bottom: number, left: number, right: number) => {
        const start = numbersStart(flowdata, left, bottom, 'r');
        if (start == null) openSumOfRow(top, bottom, left, right);
        else openSum(cellInput, fxInput, ctx, top, left, [start, bottom - 1], [left, right], formula);
    };

    for (const selection of ctx.selections ?? []) {
        const [top, bottom] = selection.row;
        const [left, right] = selection.column;
        const focusRow = selection.row_focus ?? top;
        const focusColumn = selection.column_focus ?? left;

        if (top === bottom && left === right) {
            if (bottom === 0 && right === 0) {
                openSum(cellInput, fxInput, ctx, top, left, null, null, formula, true);
            } else if (bottom > 0 && holdsNumber(flowdata[bottom - 1][left])) {
                openSumOfColumn(top, bottom, left, right);
            } else if (right > 0 && holdsNumber(flowdata[top][right - 1])) {
                openSumOfRow(top, bottom, left, right);
            } else {
                openSumOfColumn(top, bottom, left, right);
            }
        } else if (top === bottom) {
            sumLine(cellInput, fxInput, ctx, flowdata, focusColumn, top, left, right, formula, 'r');
        } else if (left === right) {
            sumLine(cellInput, fxInput, ctx, flowdata, focusRow, left, top, bottom, formula, 'c');
        } else {
            for (let r = top; r <= bottom; r += 1) {
                sumLine(cellInput, fxInput, ctx, flowdata, focusColumn, r, left, right, formula, 'r', false);
            }
            for (let c = left; c <= right; c += 1) {
                sumLine(cellInput, fxInput, ctx, flowdata, focusRow, c, top, bottom, formula, 'c', false);
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

// Where the run of numbers before `end` starts, walking back over blanks and stopping at text.
function numbersStart(d: CellMatrix, line: number, end: number, type: Line) {
    let start = null;
    let blanks = 0;
    let blankRuns = 0;

    for (let r = end - 1; r >= 0; r -= 1) {
        const cell = type === 'c' ? d[line][r] : d[r][line];

        if (holdsNumber(cell)) {
            start = r;
        } else if (!holdsValue(cell)) {
            blanks += 1;

            if (blanks >= 40) {
                if (blankRuns <= 0) {
                    blankRuns = 1;
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }

    return start;
}

function openSum(
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    ctx: Context,
    focusRow: number,
    focusColumn: number,
    rows: number[] | null,
    columns: number[] | null,
    formula: string,
    noRange = false,
) {
    if (noRange) {
        const html = `${functionCallHtml(formula.toUpperCase())}<span dir="auto" class="sheet-formula-text-color">)</span>`;
        openCellEditor(ctx, focusRow, focusColumn, { html, caret: formula.length + 2 });
        return;
    }

    if (rows == null || columns == null) return;
    const rowStart = rowLocationByIndex(rows[0], ctx.visibledatarow)[0];
    const rowEnd = rowLocationByIndex(rows[1], ctx.visibledatarow)[1];
    const columnStart = colLocationByIndex(columns[0], ctx.visibledatacolumn)[0];
    const columnEnd = colLocationByIndex(columns[1], ctx.visibledatacolumn)[1];

    const html = `${functionCallHtml(formula.toUpperCase())}<span class="sheet-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${rangeColor(
        0,
    )};">${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rows, column: columns },
        ctx.currentSheetId,
    )}</span><span dir="auto" class="sheet-formula-text-color">)</span>`;
    openCellEditor(ctx, focusRow, focusColumn, { html });

    israngeseleciton(ctx);
    ctx.formulaCache.rangestart = true;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
    ctx.formulaCache.rangechangeindex = 0;
    rangeSetValue(ctx, cellInput, { row: rows, column: columns }, fxInput);
    ctx.formulaCache.func_selectedrange = {
        left: columnStart,
        width: columnEnd - columnStart - 1,
        top: rowStart,
        height: rowEnd - rowStart - 1,
        left_move: columnStart,
        width_move: columnEnd - columnStart - 1,
        top_move: rowStart,
        height_move: rowEnd - rowStart - 1,
        row: [focusRow, focusRow],
        column: [focusColumn, focusColumn],
    };

    createFormulaRangeSelect(ctx, {
        rangeIndex: ctx.formulaCache.rangeIndex || 0,
        left: columnStart,
        width: columnEnd - columnStart - 1,
        top: rowStart,
        height: rowEnd - rowStart - 1,
    });
}

function writeSum(
    d: CellMatrix,
    r: number,
    c: number,
    rows: number[],
    columns: number[],
    formula: string,
    ctx: Context,
) {
    const f = `=${formula.toUpperCase()}(${getRangetxt(
        ctx,
        ctx.currentSheetId,
        { row: rows, column: columns },
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
    first: number,
    last: number,
    formula: string,
    type: Line,
    fillBlanks = true,
) {
    const cellAt = (at: number) => (type === 'c' ? d[at][fix] : d[fix][at]);
    const write = (at: number, along: number[], across: number[]) => {
        if (type === 'c') writeSum(d, at, fix, along, across, formula, ctx);
        else writeSum(d, fix, at, across, along, formula, ctx);
    };

    let allBlank = true;
    let holdsNumbers = false;
    for (let at = first; at <= last; at += 1) {
        const cell = cellAt(at);
        if (holdsNumber(cell)) {
            allBlank = false;
            holdsNumbers = true;
        } else if (!isRealNull(cellValue(cell))) {
            allBlank = false;
        }
    }

    if (allBlank && fillBlanks) {
        if (numbersStart(d, index, fix, type) == null) {
            if (type === 'c') openSum(cellInput, fxInput, ctx, index, fix, null, null, formula, true);
            else openSum(cellInput, fxInput, ctx, fix, index, null, null, formula, true);
            return;
        }
        const count = last - first + 1;
        for (let step = 0; step < count; step += 1) {
            const at = index === first ? first + step : last - step;
            const start = numbersStart(d, at, fix, type);
            if (start == null) break;
            write(at, [at, at], [start, fix - 1]);
        }
        return;
    }
    if (!holdsNumbers) return;

    // The sum lands on the first free cell past the selection, or it would read itself.
    const length = type === 'c' ? d.length : d[0].length;
    let at = last + 1;
    while (at < length && holdsValue(cellAt(at))) at += 1;
    if (at < length) write(at, [first, last], [fix, fix]);
}
