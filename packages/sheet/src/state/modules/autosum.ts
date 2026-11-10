// Autosum, from the Insert menu: on one cell it opens the editor on a sum of the numbers it finds above or to the left,
// to confirm with Enter or to change, and on a range it writes each sum straight past the range. With nothing to sum it
// opens an empty call. It runs inside a setContext recipe.

import { cellValue } from '../../engine/format';
import type { Cell, CellMatrix, SingleRange } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { getRangetxt, setCellValue } from './cell';
import { openCellEditor } from './cell-editor';
import { rangeColor } from './color';
import { caretTakesRange, functionCallHtml } from './formula-editor';
import { computeFormula } from './formula-exec';
import { createFormulaRangeSelect, rangeSetValue } from './formula-range';
import { colLocationByIndex, rowLocationByIndex } from './location';
import { recomputeCells } from './refresh';
import { isRealNull, isRealNum } from './validation';

// A selected line of cells: a column `c`, whose blank cells sum the numbers to their left, or a row `r`, whose blank
// cells sum those above.
type Line = 'c' | 'r';

// One autosum's workbook, editors and function name, which every step below reads.
type Autosum = {
    ctx: Context;
    d: CellMatrix;
    cellInput: HTMLDivElement;
    fxInput: HTMLDivElement | null | undefined;
    formula: string;
};

// The walk back over blanks for numbers to sum gives up past this many blank cells.
const MAX_BLANKS = 40;

const CLOSE_HTML = '<span dir="auto" class="sheet-formula-text-color">)</span>';

export function autoSelectionFormula(
    ctx: Context,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null | undefined,
    formula: string,
) {
    if (ctx.allowEdit === false) return;
    const d = getFlowdata(ctx);
    if (d == null) return;
    const sum: Autosum = { ctx, d, cellInput, fxInput, formula };

    const openSumOfRow = (top: number, bottom: number, left: number, right: number) => {
        const start = numbersStart(d, top, right, 'c');
        if (start == null) openEmptySum(sum, top, left);
        else openSum(sum, top, left, { row: [top, bottom], column: [start, right - 1] });
    };

    const openSumOfColumn = (top: number, bottom: number, left: number, right: number) => {
        const start = numbersStart(d, left, bottom, 'r');
        if (start == null) openSumOfRow(top, bottom, left, right);
        else openSum(sum, top, left, { row: [start, bottom - 1], column: [left, right] });
    };

    for (const selection of ctx.selections ?? []) {
        const [top, bottom] = selection.row;
        const [left, right] = selection.column;
        const focusRow = selection.row_focus ?? top;
        const focusColumn = selection.column_focus ?? left;

        if (top === bottom && left === right) {
            if (bottom === 0 && right === 0) {
                openEmptySum(sum, top, left);
            } else if (bottom > 0 && holdsNumber(d[bottom - 1][left])) {
                openSumOfColumn(top, bottom, left, right);
            } else if (right > 0 && holdsNumber(d[top][right - 1])) {
                openSumOfRow(top, bottom, left, right);
            } else {
                openSumOfColumn(top, bottom, left, right);
            }
        } else if (top === bottom) {
            sumLine(sum, 'r', top, selection.column, focusColumn);
        } else if (left === right) {
            sumLine(sum, 'c', left, selection.row, focusRow);
        } else {
            for (let r = top; r <= bottom; r += 1) sumLine(sum, 'r', r, selection.column, focusColumn, false);
            for (let c = left; c <= right; c += 1) sumLine(sum, 'c', c, selection.row, focusRow, false);
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
    for (let r = end - 1; r >= 0; r -= 1) {
        const cell = type === 'c' ? d[line][r] : d[r][line];
        if (holdsNumber(cell)) {
            start = r;
        } else if (holdsValue(cell)) {
            break;
        } else {
            blanks += 1;
            if (blanks > MAX_BLANKS) break;
        }
    }
    return start;
}

// The editor opens on an empty call, with the caret inside its brackets.
function openEmptySum({ ctx, formula }: Autosum, r: number, c: number) {
    const html = `${functionCallHtml(formula.toUpperCase())}${CLOSE_HTML}`;
    openCellEditor(ctx, r, c, { html, caret: formula.length + 2 });
}

// The editor opens on a sum of `range`, picked as a reference the pointer can still change.
function openSum({ ctx, cellInput, fxInput, formula }: Autosum, r: number, c: number, range: SingleRange) {
    const rowStart = rowLocationByIndex(range.row[0], ctx.visibledatarow)[0];
    const rowEnd = rowLocationByIndex(range.row[1], ctx.visibledatarow)[1];
    const columnStart = colLocationByIndex(range.column[0], ctx.visibledatacolumn)[0];
    const columnEnd = colLocationByIndex(range.column[1], ctx.visibledatacolumn)[1];
    const rect = {
        left: columnStart,
        width: columnEnd - columnStart - 1,
        top: rowStart,
        height: rowEnd - rowStart - 1,
    };

    const reference = getRangetxt(ctx, ctx.currentSheetId, range, ctx.currentSheetId);
    const referenceHtml = `<span class="sheet-formula-functionrange-cell" rangeindex="0" dir="auto" style="color:${rangeColor(0)};">${reference}</span>`;
    const html = `${functionCallHtml(formula.toUpperCase())}${referenceHtml}${CLOSE_HTML}`;
    openCellEditor(ctx, r, c, { html });

    caretTakesRange(ctx);
    ctx.formulaCache.rangestart = true;
    ctx.formulaCache.rangedrag_column_start = false;
    ctx.formulaCache.rangedrag_row_start = false;
    ctx.formulaCache.rangechangeindex = 0;
    rangeSetValue(ctx, cellInput, range, fxInput);
    ctx.formulaCache.func_selectedrange = {
        ...rect,
        left_move: rect.left,
        width_move: rect.width,
        top_move: rect.top,
        height_move: rect.height,
        row: [r, r],
        column: [c, c],
    };
    createFormulaRangeSelect(ctx, { rangeIndex: ctx.formulaCache.rangeIndex ?? 0, ...rect });
}

// Sums one selected line `fix` of `type` over [first, last]. A blank line sums what lies before each of its cells,
// and a line of numbers sums itself into the first free cell past it.
function sumLine(sum: Autosum, type: Line, fix: number, [first, last]: number[], focus: number, fillBlanks = true) {
    const { ctx, d, formula } = sum;
    const cellAt = (at: number) => (type === 'c' ? d[at][fix] : d[fix][at]);
    const write = (at: number, along: number[], across: number[]) => {
        const [r, c] = type === 'c' ? [at, fix] : [fix, at];
        const range = type === 'c' ? { row: along, column: across } : { row: across, column: along };
        const [v, f] = computeFormula(
            ctx,
            `=${formula.toUpperCase()}(${getRangetxt(ctx, ctx.currentSheetId, range, ctx.currentSheetId)})`,
        );
        setCellValue(ctx, r, c, d, { v, f });
        recomputeCells(ctx, [{ r, c, id: ctx.currentSheetId }]);
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
        if (numbersStart(d, focus, fix, type) == null) {
            if (type === 'c') openEmptySum(sum, focus, fix);
            else openEmptySum(sum, fix, focus);
            return;
        }
        const count = last - first + 1;
        for (let step = 0; step < count; step += 1) {
            const at = focus === first ? first + step : last - step;
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
