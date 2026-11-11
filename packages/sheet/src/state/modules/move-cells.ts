// Dragging a selection by its border to move the cells: onCellsMoveStart grabs it, onCellsMove draws where it
// would land, and onCellsMoveEnd moves the cells there, hidden ones too, with their borders, validation, links,
// merges and conditional-format ranges, or refuses as a cut does. A pointer past the view lands at the view's edge. The
// overlay's mouse handlers call all three.

import { clamp } from 'es-toolkit';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { GlobalCache, Selection } from '../types';
import { moveCells, movedLines } from './carry';
import { colLocation, colLocationByIndex, rowLocation, rowLocationByIndex, sheetPoint } from './location';
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

    const range = ctx.selections?.at(-1);
    if (range == null) return;

    // A press on the band can sit just past the range, and the cell it grabs is the range's nearest.
    const { x, y } = sheetPoint(ctx, e, cellArea);
    const rowGrabbed = clamp(rowLocation(y, ctx.visibledatarow)[2], range.row[0], range.row[1]);
    const columnGrabbed = clamp(colLocation(x, ctx.visibledatacolumn)[2], range.column[0], range.column[1]);
    const [rowStart, rowEnd] = rowLocationByIndex(rowGrabbed, ctx.visibledatarow);
    const [columnStart, columnEnd] = colLocationByIndex(columnGrabbed, ctx.visibledatacolumn);

    ctx.cellSelectMoveIndex = [rowGrabbed, columnGrabbed];

    // The preview renders once per pane, and each pane's clip shows its part.
    for (const ele of container.querySelectorAll('.sheet-cell-selected-move')) {
        if (!(ele instanceof HTMLElement)) continue;
        ele.style.left = `${columnStart}px`;
        ele.style.top = `${rowStart}px`;
        ele.style.width = `${columnEnd - columnStart - 1}px`;
        ele.style.height = `${rowEnd - rowStart - 1}px`;
        ele.style.display = 'block';
    }
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
    const range = ctx.selections?.at(-1);
    if (range == null) return;

    const { row, column } = moveLanding(ctx, e, cellArea, range);
    const columnStart = column[0] === 0 ? 0 : ctx.visibledatacolumn[column[0] - 1];
    const columnEnd = ctx.visibledatacolumn[column[1]];
    const rowStart = row[0] === 0 ? 0 : ctx.visibledatarow[row[0] - 1];
    const rowEnd = ctx.visibledatarow[row[1]];

    for (const ele of container.querySelectorAll('.sheet-cell-selected-move')) {
        if (!(ele instanceof HTMLElement)) continue;
        ele.style.left = `${columnStart}px`;
        ele.style.top = `${rowStart}px`;
        ele.style.width = `${columnEnd - columnStart - 2}px`;
        ele.style.height = `${rowEnd - rowStart - 2}px`;
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

    if (ctx.allowEdit === false) return;

    if (getFlowdata(ctx) == null) return;
    const last = ctx.selections?.at(-1);
    if (last == null) return;

    const { row, column } = moveLanding(ctx, e, cellArea, last);
    if (row[0] === last.row[0] && column[0] === last.column[0]) return;

    if (hasPartMC(ctx, last.row[0], last.row[1], last.column[0], last.column[1])) {
        ctx.warnDialog = PART_MERGE_REFUSAL;
        return;
    }
    const lines = movedLines(ctx, ctx.currentSheetId, last);
    if (!lines) return;

    if (hasPartMC(ctx, row[0], row[1], column[0], column[1])) {
        ctx.warnDialog = PART_MERGE_REFUSAL;
        return;
    }

    moveCells(ctx, lines, last, {
        row: row[0],
        column: column[0],
        height: row[1] - row[0] + 1,
        width: column[1] - column[0] + 1,
    });

    const refreshed = [
        { row: last.row, column: last.column },
        { row, column },
    ];

    last.row_focus = last.row_focus === last.row[0] ? row[0] : row[1];
    last.column_focus = last.column_focus === last.column[0] ? column[0] : column[1];
    last.row = row;
    last.column = column;
    ctx.selections = normalizeSelection(ctx, [last]);

    jfrefreshgrid(ctx, refreshed);
}

// Where a dragged range lands: the cell under the pointer, the pointer held inside the view and the range on the sheet.
function moveLanding(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, range: Selection) {
    const { left, top, width, height } = cellArea.getBoundingClientRect();
    // A pixel in from each edge, since a row or column owns its far edge and the view's first pixel can be the one
    // scrolled out.
    const { x, y } = sheetPoint(
        ctx,
        {
            clientX: clamp(e.clientX, left + 1, left + width - 1),
            clientY: clamp(e.clientY, top + 1, top + height - 1),
        },
        cellArea,
    );
    const [rowGrabbed, columnGrabbed] = ctx.cellSelectMoveIndex;
    const rowSpan = range.row[1] - range.row[0];
    const columnSpan = range.column[1] - range.column[0];
    const rowLast = ctx.visibledatarow.length - 1 - rowSpan;
    const columnLast = ctx.visibledatacolumn.length - 1 - columnSpan;
    const row = clamp(range.row[0] - rowGrabbed + rowLocation(y, ctx.visibledatarow)[2], 0, rowLast);
    const column = clamp(range.column[0] - columnGrabbed + colLocation(x, ctx.visibledatacolumn)[2], 0, columnLast);
    return { row: [row, row + rowSpan], column: [column, column + columnSpan] };
}
