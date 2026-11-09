// The fill handle: dragging the selection's corner extends its cells over the dragged range, and fill down and fill
// right extend one edge of a range the same way. Along each line of a fill, neighbouring cells of one kind count on,
// such as numbers along their trend, dates by days or months and text by its last number. Anything else, a lone cell
// included, repeats. The canvas overlay's mouse handlers and the keyboard handler call in here.

import dayjs from 'dayjs';
import { cloneDeep } from 'es-toolkit/compat';
import { createArrayResolver } from '../../engine/cell-resolver';
import { cfSplitRange } from '../../engine/conditional-format';
import { numberDisplay, parseCellInput, update } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { Cell, SingleRange } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { Rect } from '../types';
import { getSheetIndex } from '../utils';
import { carrySides, getBorderInfoCompute } from './border';
import { setCellValue } from './cell';
import { computeFormula } from './formula-exec';
import { colLocation, rowLocation, sheetPoint } from './location';
import { jfrefreshgrid } from './refresh';
import { normalizeSelection } from './selection';
import { addValidation, validationEntryAt } from './validation-rules';

type FillDirection = 'down' | 'up' | 'left' | 'right';

export function createDropCellRange(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    ctx.cellSelectExtending = true;
    ctx.scrolling = true;

    const { x, y } = sheetPoint(ctx, e, cellArea);
    const [rowTop, rowBottom, rowIndex] = rowLocation(y, ctx.visibledatarow);
    const [colLeft, colRight, colIndex] = colLocation(x, ctx.visibledatacolumn);

    ctx.cellSelectExtendIndex = [rowIndex, colIndex];

    showDropCellSelection(
        { left: colLeft, width: colRight - colLeft - 1, top: rowTop, height: rowBottom - rowTop - 1 },
        container,
    );
}

export function onDropCellSelect(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    const { x, y } = sheetPoint(ctx, e, cellArea);
    const [rowTop, rowBottom, rowIndex] = rowLocation(y, ctx.visibledatarow);
    const [colLeft, colRight, colIndex] = colLocation(x, ctx.visibledatacolumn);
    const [pressedRow, pressedCol] = ctx.cellSelectExtendIndex;

    if (!ctx.selections) return;
    const [firstRow, lastRow] = ctx.selections[0].row;
    const [firstCol, lastCol] = ctx.selections[0].column;

    let top = ctx.selections[0].top_move;
    let height = ctx.selections[0].height_move;
    let left = ctx.selections[0].left_move;
    let width = ctx.selections[0].width_move;

    if (top == null || height == null || left == null || width == null) return;
    if (Math.abs(pressedRow - rowIndex) > Math.abs(pressedCol - colIndex)) {
        if (rowIndex < firstRow || rowIndex > lastRow) {
            if (top >= rowTop) {
                height += top - rowTop;
                top = rowTop;
            } else {
                height = rowBottom - top - 1;
            }
        }
    } else if (colIndex < firstCol || colIndex > lastCol) {
        if (left >= colLeft) {
            width += left - colLeft;
            left = colLeft;
        } else {
            width = colRight - left - 1;
        }
    }

    showDropCellSelection({ left, width, top, height }, container);
}

export function onDropCellSelectEnd(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    ctx.cellSelectExtending = false;
    hideDropCellSelection(container);

    const { x, y } = sheetPoint(ctx, e, cellArea);
    const [rowTop, , rowIndex] = rowLocation(y, ctx.visibledatarow);
    const [colLeft, , colIndex] = colLocation(x, ctx.visibledatacolumn);
    const [pressedRow, pressedCol] = ctx.cellSelectExtendIndex;

    const selections = ctx.selections ?? [];
    const last = selections.at(-1);
    if (last == null) return;
    const { top_move, left_move } = selections[0];

    const copyRange: SingleRange = { row: last.row, column: last.column };
    let applyRange: SingleRange;
    let direction: FillDirection;
    let [firstRow, lastRow] = last.row;
    let [firstCol, lastCol] = last.column;

    if (Math.abs(pressedRow - rowIndex) > Math.abs(pressedCol - colIndex)) {
        if (rowIndex >= firstRow && rowIndex <= lastRow) return;
        if (top_move != null && top_move >= rowTop) {
            applyRange = { row: [rowIndex, firstRow - 1], column: last.column };
            direction = 'up';
            firstRow = rowIndex;
        } else {
            applyRange = { row: [lastRow + 1, rowIndex], column: last.column };
            direction = 'down';
            lastRow = rowIndex;
        }
    } else {
        if (colIndex >= firstCol && colIndex <= lastCol) return;
        if (left_move != null && left_move >= colLeft) {
            applyRange = { row: last.row, column: [colIndex, firstCol - 1] };
            direction = 'left';
            firstCol = colIndex;
        } else {
            applyRange = { row: last.row, column: [lastCol + 1, colIndex] };
            direction = 'right';
            lastCol = colIndex;
        }
    }

    if (y < 0) {
        firstRow = 0;
        [lastRow] = last.row;
    }

    if (x < 0) {
        firstCol = 0;
        [lastCol] = last.column;
    }

    if (fillTouchesMerge(ctx, copyRange, applyRange)) return;

    ctx.selections = normalizeSelection(ctx, [{ row: [firstRow, lastRow], column: [firstCol, lastCol] }]);

    updateDropCell(ctx, copyRange, applyRange, direction);

    for (const selectedMoveEle of container.querySelectorAll('.sheet-cell-selected-move')) {
        if (!(selectedMoveEle instanceof HTMLElement)) continue;
        selectedMoveEle.style.display = 'none';
    }
}

// Fill down and fill right (⌘D and ⌘R): the top row (or left column) of the range repeats over the rest of it.
export function fillFromEdge(ctx: Context, range: SingleRange, direction: 'down' | 'right') {
    const { row, column } = range;
    const down = direction === 'down';
    const [start, end] = down ? row : column;
    if (start === end) return;
    const copyRange = down ? { row: [start, start], column } : { row, column: [start, start] };
    const applyRange = down ? { row: [start + 1, end], column } : { row, column: [start + 1, end] };
    if (fillTouchesMerge(ctx, copyRange, applyRange)) return;
    updateDropCell(ctx, copyRange, applyRange, direction);
}

export function updateDropCell(
    ctx: Context,
    copyRange: SingleRange,
    applyRange: SingleRange,
    direction: FillDirection,
) {
    const d = getFlowdata(ctx);
    if (ctx.allowEdit === false || d == null) return;

    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];
    const hiddenRows = new Set(Object.keys(file.config?.rowhidden ?? {}));
    const hiddenCols = new Set(Object.keys(file.config?.colhidden ?? {}));

    // One live resolver per fill, not a snapshot per filled formula cell.
    const resolver = createArrayResolver(ctx.sheets);

    const cfg = (file.config ??= {});
    cfg.borderInfo ??= {};
    // The cells each validation rule fills, by the rule's id: a filled cell takes the rule of the cell it repeats, as
    // in Excel and Google. They land once the fill is done, one write per rule.
    const filledRules = new Map<string, SingleRange[]>();
    // The rule of each source cell, looked up once: a long fill repeats a few source cells many times.
    const sourceRules = new Map<string, string | undefined>();

    const borderInfoCompute = getBorderInfoCompute(ctx, ctx.currentSheetId, [
        copyRange.row[0],
        copyRange.row[1],
        copyRange.column[0],
        copyRange.column[1],
    ]);

    const vertical = direction === 'down' || direction === 'up';
    const backward = direction === 'up' || direction === 'left';
    const [copyStart, copyEnd] = vertical ? copyRange.row : copyRange.column;
    const [applyStart, applyEnd] = vertical ? applyRange.row : applyRange.column;
    const [lineStart, lineEnd] = vertical ? applyRange.column : applyRange.row;
    const lineHidden = vertical ? hiddenCols : hiddenRows;
    const stepHidden = vertical ? hiddenRows : hiddenCols;
    const sourceLength = copyEnd - copyStart + 1;
    const count = applyEnd - applyStart + 1;
    // The source position a step repeats. A backward fill reads the source from its far end, so the series below need
    // no direction: the last cell they read always sits beside the first cell they fill.
    const sourceAt = (step: number) => (backward ? copyEnd - (step % sourceLength) : copyStart + (step % sourceLength));

    for (let line = lineStart; line <= lineEnd; line += 1) {
        if (lineHidden.has(`${line}`)) continue;

        const source = Array.from({ length: sourceLength }, (_, step) =>
            vertical ? d[sourceAt(step)][line] : d[line][sourceAt(step)],
        );
        const filled = fillLine(source, count);

        for (let step = 0; step < count; step += 1) {
            const pos = backward ? applyEnd - step : applyStart + step;
            if (stepHidden.has(`${pos}`)) continue;

            const row = vertical ? pos : line;
            const col = vertical ? line : pos;
            const cell = filled[step];
            const sourcePos = sourceAt(step);
            const sourceRow = vertical ? sourcePos : line;
            const sourceCol = vertical ? line : sourcePos;

            d[row][col] = cell;

            if (cell?.f != null) {
                const offset = pos - sourcePos;
                const f = `=${functionCopy(cell.f, vertical ? offset : 0, vertical ? 0 : offset)}`;
                const [value, filledF] = computeFormula(ctx, f, { resolver });
                setCellValue(ctx, row, col, d, { v: value, f: filledF });
            }

            const sourceKey = `${sourceRow}_${sourceCol}`;
            carrySides(cfg.borderInfo, row, col, borderInfoCompute[sourceKey]);

            if (!sourceRules.has(sourceKey)) {
                sourceRules.set(sourceKey, validationEntryAt(file.dataValidations, sourceRow, sourceCol)?.[0]);
            }
            const ruleId = sourceRules.get(sourceKey);
            if (ruleId) {
                const cells = filledRules.get(ruleId) ?? [];
                cells.push({ row: [row, row], column: [col, col] });
                filledRules.set(ruleId, cells);
            }
        }
    }
    for (const [id, cells] of filledRules) {
        const rule = file.dataValidations?.[id]?.rule;
        if (rule) addValidation(file, id, rule, cells);
    }

    for (const rule of file.conditionalFormatRules ?? []) {
        if (rule.cellrange.some((range) => cfSplitRange(range, copyRange, applyRange, 'operatePart').length > 0)) {
            rule.cellrange.push(applyRange);
        }
    }

    jfrefreshgrid(ctx);
}

// Excel refuses a fill that would split or overwrite a merge.
function fillTouchesMerge(ctx: Context, copyRange: SingleRange, applyRange: SingleRange) {
    const merge = getSheetConfig(ctx)?.merge;
    if (merge == null) return false;
    return Object.values(merge).some(({ r, c, rs, cs }) =>
        [copyRange, applyRange].some(
            ({ row, column }) => r <= row[1] && r + rs > row[0] && c <= column[1] && c + cs > column[0],
        ),
    );
}

// Takes one source line in fill order and returns `count` cells. Each run of one kind keeps its places in the source
// on every round, and its series counts on over those places alone.
function fillLine(line: readonly (Cell | null | undefined)[], count: number) {
    const filled = new Array<Cell | null>(count).fill(null);
    let start = 0;
    while (start < line.length) {
        const kind = seriesKind(line[start]);
        let end = start + 1;
        while (end < line.length && seriesKind(line[end]) === kind) end += 1;

        const run = line.slice(start, end);
        const cellAt = runFill(kind, run);
        let nth = 0;
        for (let roundStart = start; roundStart < count; roundStart += line.length) {
            for (let i = 0; i < run.length && roundStart + i < count; i += 1) {
                filled[roundStart + i] = cellAt(nth);
                nth += 1;
            }
        }
        start = end;
    }
    return filled;
}

// Text counts only among cells with the same words around their number, so its kind is the text without the number.
function seriesKind(cell: Cell | null | undefined) {
    if (cell?.v == null || cell.f != null) return 'copy';
    if (cell.ct?.t === 'n') return 'number';
    if (cell.ct?.t === 'd') return 'date';
    const number = lastNumber(cell.m);
    return number ? `${number.before}#${number.after}` : 'copy';
}

function runFill(kind: string, run: readonly (Cell | null | undefined)[]) {
    const copy = (nth: number) => cloneDeep(run[nth % run.length]) ?? null;
    const cells = run.filter((cell) => cell != null);
    if (kind === 'copy' || cells.length < 2) return copy;

    const valueAt = kind === 'number' ? numberSeries(cells) : kind === 'date' ? dateSeries(cells) : textSeries(cells);
    if (valueAt == null) return copy;

    return (nth: number) => {
        const cell = cloneDeep(cells[nth % cells.length]);
        const value = valueAt(nth + 1);
        cell.v = value;
        if (typeof value === 'string') cell.m = value;
        else if (cell.ct?.fa != null) cell.m = numberDisplay(value, cell.ct.fa);
        return cell;
    };
}

// Each series takes how many steps past the run's last cell to go.
function numberSeries(cells: readonly Cell[]) {
    const values = cells.map((cell) => Number(cell.v));
    const meanX = (values.length - 1) / 2;
    const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
    let covariance = 0;
    let variance = 0;
    for (const [x, y] of values.entries()) {
        covariance += (x - meanX) * (y - meanY);
        variance += (x - meanX) ** 2;
    }
    const slope = covariance / variance;
    return (steps: number) => Math.round((meanY + slope * (values.length - 1 + steps - meanX)) * 100000) / 100000;
}

function dateSeries(cells: readonly Cell[]) {
    const dates = cells.map((cell) => dayjs(update('yyyy-MM-dd', cell.v)));
    const sameDay = dates.every((date) => date.date() === dates[0].date());
    const step = evenStep(
        dates.map((date) => (sameDay ? date.year() * 12 + date.month() : date.diff(dates[0], 'days'))),
    );
    if (!step) return null;
    const last = dates[dates.length - 1];
    return (steps: number) =>
        parseCellInput(last.add(step * steps, sameDay ? 'months' : 'days').format('YYYY-MM-DD'))[2];
}

function textSeries(cells: readonly Cell[]) {
    const numbers = cells.flatMap((cell) => lastNumber(cell.m) ?? []);
    const step = evenStep(numbers.map(({ value }) => value));
    if (step == null) return null;
    const { value, before, after } = numbers[numbers.length - 1];
    return (steps: number) => `${before}${Math.abs(value + step * steps)}${after}`;
}

function evenStep(values: readonly number[]) {
    const step = values[1] - values[0];
    return values.every((value, i) => i === 0 || value - values[i - 1] === step) ? step : null;
}

function lastNumber(shown: Cell['m']) {
    const text = String(shown ?? '');
    const match = [...text.matchAll(/0|[1-9][0-9]*/g)].at(-1);
    if (match == null) return null;
    return {
        value: Number(match[0]),
        before: text.slice(0, match.index),
        after: text.slice(match.index + match[0].length),
    };
}

// The extend preview renders once per overlay pane region; write every copy, as each region's clip shows its portion.
function showDropCellSelection({ width, height, top, left }: Rect, container: HTMLDivElement) {
    for (const selectedExtend of container.querySelectorAll('.sheet-cell-selected-extend')) {
        if (!(selectedExtend instanceof HTMLElement)) continue;
        selectedExtend.style.left = `${left}px`;
        selectedExtend.style.width = `${width}px`;
        selectedExtend.style.top = `${top}px`;
        selectedExtend.style.height = `${height}px`;
        selectedExtend.style.display = 'block';
    }
}

function hideDropCellSelection(container: HTMLDivElement) {
    for (const selectedExtend of container.querySelectorAll('.sheet-cell-selected-extend')) {
        if (!(selectedExtend instanceof HTMLElement)) continue;
        selectedExtend.style.display = 'none';
    }
}
