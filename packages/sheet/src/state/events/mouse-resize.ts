// The grid's resize and freeze handles: a mousedown on a row or column header's edge starts a resize, one on
// the freeze bars starts freezing rows or columns, and the overlay's mousemove and mouseup handlers finish the
// drag. A double-click on a column edge fits the column to its widest text (autoFitColumnWidth).

import { cellDisplay } from '../../engine/format';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import { caretTakesRange, deselectFloatingObject } from '../modules';
import { colLocation, rowLocation, sheetPoint } from '../modules/location';
import { getFontSet, measuringContext } from '../modules/text';
import { getSheetIndex } from '../utils';

export function handleColSizeHandleMouseDown(
    ctx: Context,
    e: MouseEvent,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    deselectFloatingObject(ctx);

    ctx.editingCellPosition = [];

    const { scrollTop } = ctx;
    const [, col, col_index] = colLocation(sheetPoint(ctx, e, cellArea).x, ctx.visibledatacolumn);

    ctx.colsResizing = true;
    ctx.scrolling = true;
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine instanceof HTMLElement) {
        changeSizeLine.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        changeSizeLine.style.borderWidth = '0 1px 0 0';
        changeSizeLine.style.top = '0';
        changeSizeLine.style.left = `${col}px`;
        changeSizeLine.style.width = '1px';
    }
    ctx.colsResizeStart = [e.clientX, col_index];
    e.stopPropagation();
}

export function handleRowSizeHandleMouseDown(
    ctx: Context,
    e: MouseEvent,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    deselectFloatingObject(ctx);

    if (
        ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start ||
        caretTakesRange(ctx)
    )
        return;
    ctx.editingCellPosition = [];

    const { scrollLeft } = ctx;
    const [, row, row_index] = rowLocation(sheetPoint(ctx, e, cellArea).y, ctx.visibledatarow);

    ctx.rowsResizing = true;
    ctx.scrolling = true;
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine instanceof HTMLElement) {
        changeSizeLine.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        changeSizeLine.style.borderWidth = '0 0 1px 0';
        changeSizeLine.style.top = `${row}px`;
        changeSizeLine.style.left = '0';
        changeSizeLine.style.height = '1px';
    }
    ctx.rowsResizeStart = [e.clientY, row_index];
    e.stopPropagation();
}

export function handleColFreezeHandleMouseDown(
    ctx: Context,
    e: MouseEvent,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    deselectFloatingObject(ctx);

    ctx.editingCellPosition = [];

    const { scrollLeft, scrollTop } = ctx;
    // The drag lines live on the main pane's transform, so they take its position even over a frozen pane.
    const col = colLocation(sheetPoint(ctx, e, cellArea).viewX + scrollLeft, ctx.visibledatacolumn)[1];

    ctx.colsFreezeDragging = true;
    ctx.scrolling = true;
    const freezeDragLine = workbookContainer.querySelector('.sheet-freeze-drag-line');
    if (freezeDragLine instanceof HTMLElement) {
        freezeDragLine.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        freezeDragLine.style.borderWidth = '0 3px 0 0';
        freezeDragLine.style.top = '0';
        freezeDragLine.style.left = `${col - 3}px`;
        freezeDragLine.style.width = '1px';
    }
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine instanceof HTMLElement) {
        changeSizeLine.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        changeSizeLine.style.borderWidth = '0 1px 0 0';
        changeSizeLine.style.top = '0';
        changeSizeLine.style.left = `${col - 3}px`;
        changeSizeLine.style.width = '1px';
    }
    e.stopPropagation();
}

export function handleRowFreezeHandleMouseDown(
    ctx: Context,
    e: MouseEvent,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    deselectFloatingObject(ctx);

    ctx.editingCellPosition = [];

    const { scrollLeft, scrollTop } = ctx;
    // The drag lines live on the main pane's transform, so they take its position even over a frozen pane.
    const row = rowLocation(sheetPoint(ctx, e, cellArea).viewY + scrollTop, ctx.visibledatarow)[1];

    ctx.rowsFreezeDragging = true;
    ctx.scrolling = true;
    const freezeDragLine = workbookContainer.querySelector('.sheet-freeze-drag-line');
    if (freezeDragLine instanceof HTMLElement) {
        freezeDragLine.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        freezeDragLine.style.borderWidth = '0 0 3px 0';
        freezeDragLine.style.top = `${row - 3}px`;
        freezeDragLine.style.left = '0';
        freezeDragLine.style.height = '1px';
    }
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine instanceof HTMLElement) {
        changeSizeLine.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        changeSizeLine.style.borderWidth = '0 0 1px 0';
        changeSizeLine.style.top = `${row - 3}px`;
        changeSizeLine.style.left = '0';
        changeSizeLine.style.height = '1px';
    }
    e.stopPropagation();
}

export function autoFitColumnWidth(ctx: Context, colIndex: number) {
    const flowdata = getFlowdata(ctx);
    const measuring = measuringContext();
    if (!flowdata || !measuring) return;

    const padding = 14;
    let maxWidth = 10;

    for (let r = 0; r < flowdata.length; r += 1) {
        const cell = flowdata[r]?.[colIndex];
        if (!cell) continue;

        if (cell.mc) {
            if (cell.mc.cs != null && cell.mc.cs > 1) continue;
            if (cell.mc.c !== colIndex) continue;
        }

        const display = cellDisplay(cell);
        if (display == null) continue;
        const text = String(display);
        if (!text) continue;

        measuring.font = getFontSet(cell);
        const width = measuring.measureText(text).width + padding;
        if (width > maxWidth) maxWidth = width;
    }

    maxWidth = Math.ceil(maxWidth);

    const idx = getSheetIndex(ctx, ctx.currentSheetId);
    if (idx == null) return;
    const cfg = (ctx.sheets[idx].config ??= {});
    cfg.columnlen ||= {};
    cfg.customWidth ||= {};
    cfg.columnlen[colIndex] = maxWidth;
    cfg.customWidth[colIndex] = 1;
}
