// Dragging a selection by its border to move the cells: onCellsMoveStart grabs it, onCellsMove draws where it
// would land, and onCellsMoveEnd moves the cells there, hidden ones too, with their borders, validation, links,
// merges and conditional-format ranges. The overlay's mouse handlers call all three.

import { cfSplitRange, withCfRanges } from '../../engine/conditional-format';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { GlobalCache } from '../types';
import { isAllowEdit } from '../utils';
import { carriedLines, carryCells } from './cell';
import { colLocation, colLocationByIndex, mousePosition, rowLocation, rowLocationByIndex } from './location';
import { jfrefreshgrid } from './refresh';
import { normalizeSelection } from './selection';
import { hasPartMC } from './validation';

const dragCellThreshold = 8;

function getCellLocationByMouse(ctx: Context, e: MouseEvent, scrollEl: HTMLDivElement, container: HTMLDivElement) {
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollEl.scrollLeft;
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollEl.scrollTop;

    return {
        row: rowLocation(y, ctx.visibledatarow),
        column: colLocation(x, ctx.visibledatacolumn),
    };
}

export function onCellsMoveStart(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    const allowEdit = isAllowEdit(ctx);
    if (allowEdit === false) {
        // Selection drag is disabled in this mode
        return;
    }

    globalCache.dragCellStartPos = { x: e.pageX, y: e.pageY };
    ctx.cellSelectMoving = true;
    ctx.scrolling = true;

    let {
        row: [row_pre, row, row_index],
        column: [col_pre, col, col_index],
    } = getCellLocationByMouse(ctx, e, scrollEl, container);

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

    // The move preview renders once per overlay pane region; write every copy —
    // each region's clip shows exactly its portion.
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
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    if (!ctx.cellSelectMoving) return;
    if (globalCache.dragCellStartPos != null) {
        const deltaX = Math.abs(globalCache.dragCellStartPos.x - e.pageX);
        const deltaY = Math.abs(globalCache.dragCellStartPos.y - e.pageY);
        if (deltaX < dragCellThreshold && deltaY < dragCellThreshold) {
            return;
        }
        globalCache.dragCellStartPos = undefined;
    }
    const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

    const rect = container.getBoundingClientRect();
    const winH = rect.height - 20;
    const winW = rect.width - 60;

    const { row: rowL, column } = getCellLocationByMouse(ctx, e, scrollEl, container);
    let [row_pre, row] = rowL;
    let [col_pre, col] = column;
    const row_index = rowL[2];
    const col_index = column[2];

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];
    if (ctx.selections == null) return;
    let row_s = ctx.selections[0].row[0] - row_index_original + row_index;
    let row_e = ctx.selections[0].row[1] - row_index_original + row_index;

    let col_s = ctx.selections[0].column[0] - col_index_original + col_index;
    let col_e = ctx.selections[0].column[1] - col_index_original + col_index;

    if (row_s < 0 || y < 0) {
        row_s = 0;
        row_e = ctx.selections[0].row[1] - ctx.selections[0].row[0];
    }

    if (col_s < 0 || x < 0) {
        col_s = 0;
        col_e = ctx.selections[0].column[1] - ctx.selections[0].column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
        row_s = ctx.visibledatarow.length - 1 - ctx.selections[0].row[1] + ctx.selections[0].row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - ctx.selections[0].column[1] + ctx.selections[0].column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    col_pre = col_s - 1 === -1 ? 0 : ctx.visibledatacolumn[col_s - 1];
    col = ctx.visibledatacolumn[col_e];
    row_pre = row_s - 1 === -1 ? 0 : ctx.visibledatarow[row_s - 1];
    row = ctx.visibledatarow[row_e];

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
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    // Change selection box position and replace target cells
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

    const [x, y] = mousePosition(e.pageX, e.pageY, ctx);

    const rect = container.getBoundingClientRect();
    const winH = rect.height - 20;
    const winW = rect.width - 60;

    const {
        row: [, , row_index],
        column: [, , col_index],
    } = getCellLocationByMouse(ctx, e, scrollEl, container);

    const allowEdit = isAllowEdit(ctx, [
        {
            row: [row_index, row_index],
            column: [col_index, col_index],
        },
    ]);
    if (!allowEdit) return;

    const row_index_original = ctx.cellSelectMoveIndex[0];
    const col_index_original = ctx.cellSelectMoveIndex[1];

    if (row_index === row_index_original && col_index === col_index_original) {
        return;
    }

    const d = getFlowdata(ctx);
    if (d == null || ctx.selections == null) return;
    const last = ctx.selections[ctx.selections.length - 1];

    // Selection contains partial cells
    if (hasPartMC(ctx, last.row[0], last.row[1], last.column[0], last.column[1])) {
        ctx.warnDialog = 'Cannot perform this operation on merged cells';
        return;
    }

    let row_s = last.row[0] - row_index_original + row_index;
    let row_e = last.row[1] - row_index_original + row_index;
    let col_s = last.column[0] - col_index_original + col_index;
    let col_e = last.column[1] - col_index_original + col_index;

    if (row_s < 0 || y < 0) {
        row_s = 0;
        row_e = last.row[1] - last.row[0];
    }

    if (col_s < 0 || x < 0) {
        col_s = 0;
        col_e = last.column[1] - last.column[0];
    }

    if (row_e >= ctx.visibledatarow.length - 1 || y > winH) {
        row_s = ctx.visibledatarow.length - 1 - last.row[1] + last.row[0];
        row_e = ctx.visibledatarow.length - 1;
    }

    if (col_e >= ctx.visibledatacolumn.length - 1 || x > winW) {
        col_s = ctx.visibledatacolumn.length - 1 - last.column[1] + last.column[0];
        col_e = ctx.visibledatacolumn.length - 1;
    }

    // Replacement position contains partial cells
    if (hasPartMC(ctx, row_s, row_e, col_s, col_e)) {
        ctx.warnDialog = 'Cannot perform this operation on merged cells';
        return;
    }

    carryCells(
        ctx,
        carriedLines(ctx, ctx.currentSheetId, [last], false),
        [{ row: row_s, column: col_s, height: row_e - row_s + 1, width: col_e - col_s + 1 }],
        ({ source }) => source,
        { cut: true },
    );

    // A rule over the moved cells moves with them.
    const rules = getSheet(ctx).conditionalFormatRules ?? [];
    for (let i = 0; i < rules.length; i += 1) {
        const cellrange = rules[i].cellrange.flatMap((range) =>
            cfSplitRange(range, last, { row: [row_s, row_e], column: [col_s, col_e] }, 'allPart'),
        );
        rules[i] = withCfRanges(rules[i], cellrange);
    }

    const range = [
        { row: last.row, column: last.column },
        { row: [row_s, row_e], column: [col_s, col_e] },
    ];

    last.row_focus = ctx.selections[0].row_focus === ctx.selections[0].row[0] ? row_s : row_e;
    last.column_focus = ctx.selections[0].column_focus === ctx.selections[0].column[0] ? col_s : col_e;
    last.row = [row_s, row_e];
    last.column = [col_s, col_e];
    ctx.selections = normalizeSelection(ctx, [last]);

    jfrefreshgrid(ctx, d, range);
}
