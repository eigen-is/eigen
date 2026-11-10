// Picking a range into a formula with the pointer: while a formula is open, a click or drag on the grid or a
// header writes its reference into the editor at the caret (rangeSetValue) and draws the colored boxes over the
// formula's ranges (createRangeHighlight). The drag handlers here move that pick as the pointer moves.

import { escapeHtml } from '@workspace/lib/html';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import type { RangeOrWholeAxis, Rect } from '../types';
import { getRangetxt, mergeMoveMain } from './cell';
import { rangeColor } from './color';
import { selectTextOffsets } from './cursor';
import { formulaUIState, setFunctionHTMLIndex } from './formula-cache';
import { caretTakesRange } from './formula-editor';
import { getcellrange } from './formula-exec';
import { colLocation, rowLocation, sheetPoint } from './location';
import { seletedHighlistByindex } from './selection';

export function createFormulaRangeSelect(ctx: Context, select: { rangeIndex: number } & Rect) {
    ctx.formulaRangeSelect = select;
}

export function createRangeHighlight(ctx: Context, inputInnerHtmlStr: string, ignoreRangeIndex = -1) {
    const $span = new DOMParser().parseFromString(inputInnerHtmlStr, 'text/html').body;
    const formulaRanges: {
        rangeIndex: number;
        left: number;
        top: number;
        width: number;
        height: number;
        backgroundColor: string;
    }[] = [];
    for (const ele of $span.querySelectorAll('span.sheet-formula-functionrange-cell')) {
        const rangeIndex = parseInt(ele.getAttribute('rangeindex') || '0', 10);
        if (rangeIndex === ignoreRangeIndex) continue;
        const cellrange = getcellrange(ctx, ele.textContent || '');
        if (rangeIndex === ctx.formulaCache.selectingRangeIndex || cellrange == null) continue;
        if (
            cellrange.sheetId === ctx.currentSheetId ||
            (!cellrange.sheetId && ctx.formulaCache.rangetosheet === ctx.currentSheetId)
        ) {
            const rect = seletedHighlistByindex(
                ctx,
                cellrange.row[0],
                cellrange.row[1],
                cellrange.column[0],
                cellrange.column[1],
            );
            if (rect) {
                formulaRanges.push({
                    rangeIndex,
                    ...rect,
                    backgroundColor: rangeColor(rangeIndex),
                });
            }
        }
    }
    ctx.formulaRangeHighlight = formulaRanges;
}

export function rangeSetValue(
    ctx: Context,
    cellInput: HTMLDivElement,
    selected: RangeOrWholeAxis,
    fxInput?: HTMLDivElement | null,
) {
    let $editor = cellInput;
    let $copyTo = fxInput;
    if (document.activeElement?.id === 'sheet-functionbox-cell' && fxInput) {
        $editor = fxInput;
        $copyTo = cellInput;
    }
    let range = '';
    const rf = selected.row[0];
    const cf = selected.column[0];
    const merge = getSheetConfig(ctx)?.merge;
    if (rf !== null && cf !== null && merge != null && `${rf}_${cf}` in merge) {
        range = getRangetxt(
            ctx,
            ctx.currentSheetId,
            {
                column: [cf, cf],
                row: [rf, rf],
            },
            ctx.formulaCache.rangetosheet,
        );
    } else {
        range = getRangetxt(ctx, ctx.currentSheetId, selected, ctx.formulaCache.rangetosheet);
    }

    if (
        !caretTakesRange(ctx) &&
        (ctx.formulaCache.rangestart || ctx.formulaCache.rangedrag_column_start || ctx.formulaCache.rangedrag_row_start)
    ) {
        const span = $editor.querySelector(`span[rangeindex='${ctx.formulaCache.rangechangeindex}']`);
        if (span instanceof HTMLElement) {
            // The reference holds a sheet's name, and markup is a legal one. The caret counts the text as rendered,
            // which the escaped markup is longer than.
            span.innerHTML = escapeHtml(range);
            selectTextOffsets(span, range.length, range.length);
        }
    } else {
        const function_str = `<span class="sheet-formula-functionrange-cell" rangeindex="${formulaUIState.functionHTMLIndex}" dir="auto" style="color:${rangeColor(formulaUIState.functionHTMLIndex)};">${escapeHtml(range)}</span>`;
        const newEle = new DOMParser().parseFromString(function_str, 'text/html').body.childNodes[0];
        const refEle = ctx.formulaCache.rangeSetValueTo;
        if (refEle?.parentNode) {
            const leftPar = document.getElementsByClassName('sheet-formula-text-lpar')?.[0];

            // handle case when user autocompletes the formula
            if (leftPar?.parentElement?.classList.contains('sheet-formula-text-color')) {
                leftPar.parentNode?.appendChild(newEle);
            } else {
                refEle.parentNode.insertBefore(newEle, refEle.nextSibling);
            }
        } else {
            $editor.appendChild(newEle);
        }
        ctx.formulaCache.rangechangeindex = formulaUIState.functionHTMLIndex;
        const span = $editor.querySelector(`span[rangeindex='${ctx.formulaCache.rangechangeindex}']`);
        if (span instanceof HTMLElement) selectTextOffsets(span, range.length, range.length);
        setFunctionHTMLIndex(formulaUIState.functionHTMLIndex + 1);
    }

    if ($copyTo) $copyTo.innerHTML = $editor.innerHTML;
}

export function onFormulaRangeDragEnd(ctx: Context) {
    if (ctx.formulaCache.func_selectedrange) {
        const {
            left_move: left,
            top_move: top,
            width_move: width,
            height_move: height,
        } = ctx.formulaCache.func_selectedrange;
        if (
            left != null &&
            top != null &&
            width != null &&
            height != null &&
            (ctx.formulaCache.rangestart ||
                ctx.formulaCache.rangedrag_column_start ||
                ctx.formulaCache.rangedrag_row_start)
        )
            ctx.formulaRangeSelect = {
                rangeIndex: ctx.formulaCache.rangeIndex ?? 0,
                left,
                top,
                width,
                height,
            };
    }
    ctx.formulaCache.selectingRangeIndex = -1;
}

// The formula range select renders once per overlay pane region; write every
// copy — each region's clip shows exactly its portion.
function setRangeSelect(container: HTMLDivElement, left: number, top: number, height: number, width: number) {
    for (const rangeElement of container.querySelectorAll('.sheet-formula-functionrange-select')) {
        if (!(rangeElement instanceof HTMLElement)) continue;
        rangeElement.style.left = `${left}px`;
        rangeElement.style.top = `${top}px`;
        rangeElement.style.height = `${height}px`;
        rangeElement.style.width = `${width}px`;
    }
}

// Where the picked range spans on one axis as the pointer reaches the line from `start` to `end`, the line `index`:
// from the line to the far edge of what was picked, keeping the picked line the drag began on.
function dragSpan(
    picked: number[],
    pickedStart: number,
    pickedSize: number,
    start: number,
    end: number,
    index: number,
) {
    if (pickedStart > start) return { start, size: pickedStart + pickedSize - start, span: [index, picked[1]] };
    if (pickedStart === start) return { start, size: pickedStart + pickedSize - start, span: [index, picked[0]] };
    return { start: pickedStart, size: end - pickedStart - 1, span: [picked[0], index] };
}

// The range being picked, with the pixel rect it was picked at.
function pickedRange(ctx: Context) {
    const picked = ctx.formulaCache.func_selectedrange;
    if (picked?.left == null || picked.top == null || picked.width == null || picked.height == null) return undefined;
    return { picked, left: picked.left, top: picked.top, width: picked.width, height: picked.height };
}

export function rangeDrag(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const from = pickedRange(ctx);
    if (!from) return;
    const { picked } = from;
    const { x, y } = sheetPoint(ctx, e, cellArea);
    const [rowStart, rowEnd, row] = rowLocation(y, ctx.visibledatarow);
    const [colStart, colEnd, col] = colLocation(x, ctx.visibledatacolumn);
    const rows = dragSpan(picked.row, from.top, from.height, rowStart, rowEnd, row);
    const columns = dragSpan(picked.column, from.left, from.width, colStart, colEnd, col);

    let rowSpan = rows.span;
    let columnSpan = columns.span;
    let top = rows.start;
    let height = rows.size;
    let left = columns.start;
    let width = columns.size;
    const merged = mergeMoveMain(ctx, columnSpan, rowSpan, top, height, left, width);
    if (merged != null) [columnSpan, rowSpan, top, height, left, width] = merged;

    picked.row = rowSpan;
    picked.column = columnSpan;
    picked.left_move = left;
    picked.width_move = width;
    picked.top_move = top;
    picked.height_move = height;

    rangeSetValue(ctx, cellInput, { row: rowSpan, column: columnSpan }, fxInput);
    setRangeSelect(container, left, top, height, width);
    e.preventDefault();
}

export function rangeDragColumn(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const from = pickedRange(ctx);
    if (!from) return;
    const { picked } = from;
    const { x } = sheetPoint(ctx, e, cellArea);
    const lastRow = ctx.visibledatarow.length - 1;
    const bottom = ctx.visibledatarow[lastRow];
    const [colStart, colEnd, col] = colLocation(x, ctx.visibledatacolumn);
    const columns = dragSpan(picked.column, from.left, from.width, colStart, colEnd, col);

    let columnSpan = columns.span;
    let left = columns.start;
    let width = columns.size;
    const merged = mergeMoveMain(ctx, columnSpan, [0, lastRow], 0, bottom - 1, left, width);
    if (merged != null) [columnSpan, , , , left, width] = merged;

    picked.column = columnSpan;
    picked.left_move = left;
    picked.width_move = width;

    rangeSetValue(ctx, cellInput, { row: [null, null], column: columnSpan }, fxInput);
    setRangeSelect(container, left, 0, bottom - 1, width);
}

export function rangeDragRow(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const from = pickedRange(ctx);
    if (!from) return;
    const { picked } = from;
    const { y } = sheetPoint(ctx, e, cellArea);
    const [rowStart, rowEnd, row] = rowLocation(y, ctx.visibledatarow);
    const lastColumn = ctx.visibledatacolumn.length - 1;
    const right = ctx.visibledatacolumn[lastColumn];
    const rows = dragSpan(picked.row, from.top, from.height, rowStart, rowEnd, row);

    let rowSpan = rows.span;
    let top = rows.start;
    let height = rows.size;
    const merged = mergeMoveMain(ctx, [0, lastColumn], rowSpan, top, height, 0, right - 1);
    if (merged != null) [, rowSpan, top, height] = merged;

    picked.row = rowSpan;
    picked.top_move = top;
    picked.height_move = height;

    rangeSetValue(ctx, cellInput, { row: rowSpan, column: [null, null] }, fxInput);
    setRangeSelect(container, 0, top, height, right - 1);
}
