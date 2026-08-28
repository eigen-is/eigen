import type { InlineStringSegment } from '../../engine/types';
import type { Freezen } from '..';
import { type Context, getFlowdata } from '../context';
import { cancelActiveImgItem, israngeseleciton } from '../modules';
import { isInlineStringCell } from '../modules/inline-string';
import { colLocation, rowLocation } from '../modules/location';
import { getFontSet } from '../modules/text';
import type { GlobalCache } from '../types';
import { getSheetIndex } from '../utils';

export function fixPositionOnFrozenCells(
    freeze: Freezen | undefined,
    x: number,
    y: number,
    mouseX: number,
    mouseY: number,
) {
    let inHorizontalFreeze = false;
    let inVerticalFreeze = false;

    if (!freeze) return { x, y, inHorizontalFreeze, inVerticalFreeze };

    const verticalData = freeze?.vertical?.freezenverticaldata;
    const horizontalData = freeze?.horizontal?.freezenhorizontaldata;

    if (verticalData != null && mouseX < verticalData.pos - verticalData.scroll) {
        x = mouseX + verticalData.scroll;
        inVerticalFreeze = true;
    }

    if (horizontalData != null && mouseY < horizontalData.pos - horizontalData.scroll) {
        y = mouseY + horizontalData.scroll;
        inHorizontalFreeze = true;
    }

    return { x, y, inHorizontalFreeze, inVerticalFreeze };
}

export function handleColSizeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.editingCellPosition = [];

    const { scrollLeft } = ctx;
    const { scrollTop } = ctx;

    const mouseX = e.pageX - headerContainer.getBoundingClientRect().left - window.scrollX;
    const _x = mouseX + scrollLeft;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x } = fixPositionOnFrozenCells(freeze, _x, 0, mouseX, 0);

    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];
    const col_index = col_location[2];

    ctx.colsResizing = true;
    ctx.scrolling = true;
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        ele.style.borderWidth = '0 1px 0 0';
        ele.style.top = '0';
        ele.style.left = `${col - 3}px`;
        ele.style.width = '1px';
    }
    ctx.colsResizeStart = [_x, col_index];
    e.stopPropagation();
}

export function handleRowSizeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    cancelActiveImgItem(ctx, globalCache);

    if (
        ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start ||
        israngeseleciton(ctx)
    )
        return;
    ctx.editingCellPosition = [];

    const { scrollLeft } = ctx;
    const { scrollTop } = ctx;

    const mouseY = e.pageY - headerContainer.getBoundingClientRect().top - window.scrollY;
    const _y = mouseY + scrollTop;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { y } = fixPositionOnFrozenCells(freeze, 0, _y, 0, mouseY);

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];
    const row_index = row_location[2];

    ctx.rowsResizing = true;
    ctx.scrolling = true;
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        ele.style.borderWidth = '0 0 1px 0';
        ele.style.top = `${row - 3}px`;
        ele.style.left = '0';
        ele.style.height = '1px';
    }
    ctx.rowsResizeStart = [_y, row_index];
    e.stopPropagation();
}

export function handleColFreezeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.editingCellPosition = [];

    const { scrollLeft } = ctx;
    const { scrollTop } = ctx;

    const x = e.pageX - headerContainer.getBoundingClientRect().left + scrollLeft;

    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];

    ctx.colsFreezeDragging = true;
    ctx.scrolling = true;
    const freezeDragLine = workbookContainer.querySelector('.sheet-freeze-drag-line');
    if (freezeDragLine) {
        const ele = freezeDragLine as HTMLDivElement;
        ele.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        ele.style.borderWidth = '0 3px 0 0';
        ele.style.top = '0';
        ele.style.left = `${col - 3}px`;
        ele.style.width = '1px';
    }
    // Reuse change-size-line to show a thin resize indicator alongside the freeze line
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.height = `${cellArea.getBoundingClientRect().height + scrollTop}px`;
        ele.style.borderWidth = '0 1px 0 0';
        ele.style.top = '0';
        ele.style.left = `${col - 3}px`;
        ele.style.width = '1px';
    }
    e.stopPropagation();
}

export function handleRowFreezeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement,
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.editingCellPosition = [];

    const { scrollLeft } = ctx;
    const { scrollTop } = ctx;

    const y = e.pageY - headerContainer.getBoundingClientRect().top + scrollTop;

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];

    ctx.rowsFreezeDragging = true;
    ctx.scrolling = true;
    const freezeDragLine = workbookContainer.querySelector('.sheet-freeze-drag-line');
    if (freezeDragLine) {
        const ele = freezeDragLine as HTMLDivElement;
        ele.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        ele.style.borderWidth = '0 0 3px 0';
        ele.style.top = `${row - 3}px`;
        ele.style.left = '0';
        ele.style.height = '1px';
    }
    // Reuse change-size-line to show a thin resize indicator alongside the freeze line
    const changeSizeLine = workbookContainer.querySelector('.sheet-change-size-line');
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.width = `${cellArea.getBoundingClientRect().width + scrollLeft}px`;
        ele.style.borderWidth = '0 0 1px 0';
        ele.style.top = `${row - 3}px`;
        ele.style.left = '0';
        ele.style.height = '1px';
    }
    e.stopPropagation();
}

export function autoFitColumnWidth(ctx: Context, colIndex: number, canvas: HTMLCanvasElement) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    const renderCtx = canvas.getContext('2d');
    if (!renderCtx) return;

    const padding = 14;
    let maxWidth = 10;

    for (let r = 0; r < flowdata.length; r += 1) {
        const cell = flowdata[r]?.[colIndex];
        if (!cell) continue;

        if (cell.mc) {
            if (cell.mc.cs != null && cell.mc.cs > 1) continue;
            if (cell.mc.c !== colIndex) continue;
        }

        let text: string;
        if (isInlineStringCell(cell)) {
            text = cell.ct!.s.map((seg: InlineStringSegment) => seg.v ?? '').join('');
        } else {
            const display = cell.m ?? cell.v;
            if (display == null) continue;
            text = String(display);
        }
        if (!text) continue;

        const fontset = getFontSet(cell, ctx.defaultFontSize);
        renderCtx.font = fontset;
        const measured = renderCtx.measureText(text);
        const width = measured.width + padding;
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
