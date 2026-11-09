// Dragging a selection by its border to move the cells: onCellsMoveStart grabs it, onCellsMove draws where it
// would land, and onCellsMoveEnd moves the cells there, hidden ones too, with their borders, validation, links,
// merges and conditional-format ranges, or refuses as a cut does. The overlay's mouse handlers call all three.

import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { GlobalCache } from '../types';
import { moveCells, movedLines } from './carry';
import {
    colLocation,
    colLocationByIndex,
    rowLocation,
    rowLocationByIndex,
    SCROLLBAR_MARGIN,
    sheetPoint,
} from './location';
import { jfrefreshgrid } from './refresh';
import { normalizeSelection } from './selection';
import { hasPartMC, PART_MERGE_REFUSAL } from './validation';

const dragCellThreshold = 8;

export function onCellsMoveStart(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
) {
    if (ctx.allowEdit === false) {
        return;
    }

    globalCache.dragCellStartPos = { x: e.clientX, y: e.clientY };
    ctx.cellSelectMoving = true;
    ctx.scrolling = true;

    const { x, y } = sheetPoint(ctx, e, cellArea);
    let [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);
    let [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

    const range = ctx.selections?.at(-1);
    if (range == null) return;

    if (row_index < range.row[0]) {
        [row_index] = range.row;
    } else if (row_index > range.row[1]) [, row_index] = range.row;
    if (col_index < range.column[0]) {
        [col_index] = range.column;
    } else if (col_index > range.column[1]) [, col_index] = range.column;
    [row_pre, row] = rowLocationByIndex(row_index, ctx.visibledatarow);
    [col_pre, col] = colLocationByIndex(col_index, ctx.visibledatacolumn);

    ctx.cellSelectMoveIndex = [row_index, col_index];

    // The preview renders once per pane, and each pane's clip shows its part.
    const eles = container.querySelectorAll('.sheet-cell-selected-move');
    if (eles.length === 0) return;
    for (const ele of eles) {
        if (!(ele instanceof HTMLElement)) continue;
        ele.style.left = `${col_pre}px`;
        ele.style.top = `${row_pre}px`;
        ele.style.width = `${col - col_pre - 1}px`;
        ele.style.height = `${row - row_pre - 1}px`;
        ele.style.display = 'block';
    }

    e.stopPropagation();
}

export function onCellsMove(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
) {
    if (!ctx.cellSelectMoving) return;
    if (globalCache.dragCellStartPos != null) {
        const deltaX = Math.abs(globalCache.dragCellStartPos.x - e.clientX);
        const deltaY = Math.abs(globalCache.dragCellStartPos.y - e.clientY);
        if (deltaX < dragCellThreshold && deltaY < dragCellThreshold) {
            return;
        }
        globalCache.dragCellStartPos = undefined;
    }
    const { x, y, viewX, viewY, width, height } = sheetPoint(ctx, e, cellArea);
    const winW = width - SCROLLBAR_MARGIN;
    const row_index = rowLocation(y, ctx.visibledatarow)[2];
    const col_index = colLocation(x, ctx.visibledatacolumn)[2];

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];
    if (ctx.selections == null) return;
    let row_s = ctx.selections[0].row[0] - row_index_original + row_index;
    let row_e = ctx.selections[0].row[1] - row_index_original + row_index;

    let col_s = ctx.selections[0].column[0] - col_index_original + col_index;
    let col_e = ctx.selections[0].column[1] - col_index_original + col_index;

    if (row_s < 0 || viewY < 0) {
        row_s = 0;
        row_e = ctx.selections[0].row[1] - ctx.selections[0].row[0];
    }

    if (col_s < 0 || viewX < 0) {
        col_s = 0;
        col_e = ctx.selections[0].column[1] - ctx.selections[0].column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || viewY > height) {
        row_s = ctx.visibledatarow.length - 1 - ctx.selections[0].row[1] + ctx.selections[0].row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || viewX > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - ctx.selections[0].column[1] + ctx.selections[0].column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    const col_pre = col_s === 0 ? 0 : ctx.visibledatacolumn[col_s - 1];
    const col = ctx.visibledatacolumn[col_e];
    const row_pre = row_s === 0 ? 0 : ctx.visibledatarow[row_s - 1];
    const row = ctx.visibledatarow[row_e];

    for (const ele of container.querySelectorAll('.sheet-cell-selected-move')) {
        if (!(ele instanceof HTMLElement)) continue;
        ele.style.left = `${col_pre}px`;
        ele.style.top = `${row_pre}px`;
        ele.style.width = `${col - col_pre - 2}px`;
        ele.style.height = `${row - row_pre - 2}px`;
        ele.style.display = 'block';
    }
}

export function onCellsMoveEnd(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
) {
    if (!ctx.cellSelectMoving) return;
    ctx.cellSelectMoving = false;
    for (const ele of container.querySelectorAll('.sheet-cell-selected-move')) {
        if (!(ele instanceof HTMLElement)) continue;
        ele.style.display = 'none';
    }
    if (globalCache.dragCellStartPos != null) {
        globalCache.dragCellStartPos = undefined;
        return;
    }

    const { x, y, viewX, viewY, width, height } = sheetPoint(ctx, e, cellArea);
    const winW = width - SCROLLBAR_MARGIN;
    const row_index = rowLocation(y, ctx.visibledatarow)[2];
    const col_index = colLocation(x, ctx.visibledatacolumn)[2];

    if (ctx.allowEdit === false) return;

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];

    if (row_index === row_index_original && col_index === col_index_original) {
        return;
    }

    const d = getFlowdata(ctx);
    if (d == null || ctx.selections == null) return;
    const last = ctx.selections[ctx.selections.length - 1];

    if (hasPartMC(ctx, last.row[0], last.row[1], last.column[0], last.column[1])) {
        ctx.warnDialog = PART_MERGE_REFUSAL;
        return;
    }
    const lines = movedLines(ctx, ctx.currentSheetId, last);
    if (!lines) return;

    let row_s = last.row[0] - row_index_original + row_index;
    let row_e = last.row[1] - row_index_original + row_index;
    let col_s = last.column[0] - col_index_original + col_index;
    let col_e = last.column[1] - col_index_original + col_index;

    if (row_s < 0 || viewY < 0) {
        row_s = 0;
        row_e = last.row[1] - last.row[0];
    }

    if (col_s < 0 || viewX < 0) {
        col_s = 0;
        col_e = last.column[1] - last.column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || viewY > height) {
        row_s = ctx.visibledatarow.length - 1 - last.row[1] + last.row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || viewX > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - last.column[1] + last.column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    if (hasPartMC(ctx, row_s, row_e, col_s, col_e)) {
        ctx.warnDialog = PART_MERGE_REFUSAL;
        return;
    }

    moveCells(ctx, lines, last, {
        row: row_s,
        column: col_s,
        height: row_e - row_s + 1,
        width: col_e - col_s + 1,
    });

    const range = [
        { row: last.row, column: last.column },
        { row: [row_s, row_e], column: [col_s, col_e] },
    ];

    last.row_focus = ctx.selections[0].row_focus === ctx.selections[0].row[0] ? row_s : row_e;
    last.column_focus = ctx.selections[0].column_focus === ctx.selections[0].column[0] ? col_s : col_e;
    last.row = [row_s, row_e];
    last.column = [col_s, col_e];
    ctx.selections = normalizeSelection(ctx, [last]);

    jfrefreshgrid(ctx, range);
}
