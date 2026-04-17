import {Freezen} from "..";
import {Context} from "../context";
import {cancelActiveImgItem, israngeseleciton} from "../modules";
import {colLocation, rowLocation} from "../modules/location";
import {GlobalCache} from "../types";

/**
 * Adjusts mouse coordinates to account for frozen rows/columns.
 * Returns corrected x/y positions and flags indicating whether the mouse
 * is inside a frozen region.
 */
export function fixPositionOnFrozenCells(
    freeze: Freezen | undefined,
    x: number,
    y: number,
    mouseX: number,
    mouseY: number
) {
    let inHorizontalFreeze = false;
    let inVerticalFreeze = false;

    if (!freeze) return {x, y, inHorizontalFreeze, inVerticalFreeze};

    const freezenverticaldata = freeze?.vertical?.freezenverticaldata;
    const freezenhorizontaldata = freeze?.horizontal?.freezenhorizontaldata;

    if (
        freezenverticaldata != null &&
        mouseX < freezenverticaldata[0] - freezenverticaldata[2]
    ) {
        x = mouseX + freezenverticaldata[2];
        inVerticalFreeze = true;
    }

    if (
        freezenhorizontaldata != null &&
        mouseY < freezenhorizontaldata[0] - freezenhorizontaldata[2]
    ) {
        y = mouseY + freezenhorizontaldata[2];
        inHorizontalFreeze = true;
    }

    return {x, y, inHorizontalFreeze, inVerticalFreeze};
}

export function handleColSizeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.luckysheetCellUpdate = [];

    const {scrollLeft} = ctx;
    const {scrollTop} = ctx;

    const mouseX =
        e.pageX - headerContainer.getBoundingClientRect().left - window.scrollX;
    const _x = mouseX + scrollLeft;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const {x} = fixPositionOnFrozenCells(freeze, _x, 0, mouseX, 0);

    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];
    const col_index = col_location[2];

    ctx.luckysheet_cols_change_size = true;
    ctx.luckysheet_scroll_status = true;
    const changeSizeLine = workbookContainer.querySelector(
        ".fortune-change-size-line"
    );
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.height = `${
            cellArea.getBoundingClientRect().height + scrollTop
        }px`;
        ele.style.borderWidth = "0 1px 0 0";
        ele.style.top = "0";
        ele.style.left = `${col - 3}px`;
        ele.style.width = "1px";
    }
    ctx.luckysheet_cols_change_size_start = [_x, col_index];
    e.stopPropagation();
}

export function handleRowSizeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement
) {
    cancelActiveImgItem(ctx, globalCache);

    if (
        ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start ||
        israngeseleciton(ctx)
    )
        return;
    ctx.luckysheetCellUpdate = [];

    const {scrollLeft} = ctx;
    const {scrollTop} = ctx;

    const mouseY =
        e.pageY - headerContainer.getBoundingClientRect().top - window.scrollY;
    const _y = mouseY + scrollTop;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const {y} = fixPositionOnFrozenCells(freeze, 0, _y, 0, mouseY);

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];
    const row_index = row_location[2];

    ctx.luckysheet_rows_change_size = true;
    ctx.luckysheet_scroll_status = true;
    const changeSizeLine = workbookContainer.querySelector(
        ".fortune-change-size-line"
    );
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.width = `${
            cellArea.getBoundingClientRect().width + scrollLeft
        }px`;
        ele.style.borderWidth = "0 0 1px 0";
        ele.style.top = `${row - 3}px`;
        ele.style.left = "0";
        ele.style.height = "1px";
    }
    ctx.luckysheet_rows_change_size_start = [_y, row_index];
    e.stopPropagation();
}

export function handleColFreezeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.luckysheetCellUpdate = [];

    const {scrollLeft} = ctx;
    const {scrollTop} = ctx;

    const x = e.pageX - headerContainer.getBoundingClientRect().left + scrollLeft;

    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];

    ctx.luckysheet_cols_freeze_drag = true;
    ctx.luckysheet_scroll_status = true;
    const freezeDragLine = workbookContainer.querySelector(
        ".fortune-freeze-drag-line"
    );
    if (freezeDragLine) {
        const ele = freezeDragLine as HTMLDivElement;
        ele.style.height = `${
            cellArea.getBoundingClientRect().height + scrollTop
        }px`;
        ele.style.borderWidth = "0 3px 0 0";
        ele.style.top = "0";
        ele.style.left = `${col - 3}px`;
        ele.style.width = "1px";
    }
    // Reuse change-size-line to show a thin resize indicator alongside the freeze line
    const changeSizeLine = workbookContainer.querySelector(
        ".fortune-change-size-line"
    );
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.height = `${
            cellArea.getBoundingClientRect().height + scrollTop
        }px`;
        ele.style.borderWidth = "0 1px 0 0";
        ele.style.top = "0";
        ele.style.left = `${col - 3}px`;
        ele.style.width = "1px";
    }
    e.stopPropagation();
}

export function handleRowFreezeHandleMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    headerContainer: HTMLDivElement,
    workbookContainer: HTMLDivElement,
    cellArea: HTMLDivElement
) {
    cancelActiveImgItem(ctx, globalCache);

    ctx.luckysheetCellUpdate = [];

    const {scrollLeft} = ctx;
    const {scrollTop} = ctx;

    const y = e.pageY - headerContainer.getBoundingClientRect().top + scrollTop;

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];

    ctx.luckysheet_rows_freeze_drag = true;
    ctx.luckysheet_scroll_status = true;
    const freezeDragLine = workbookContainer.querySelector(
        ".fortune-freeze-drag-line"
    );
    if (freezeDragLine) {
        const ele = freezeDragLine as HTMLDivElement;
        ele.style.width = `${
            cellArea.getBoundingClientRect().width + scrollLeft
        }px`;
        ele.style.borderWidth = "0 0 3px 0";
        ele.style.top = `${row - 3}px`;
        ele.style.left = "0";
        ele.style.height = "1px";
    }
    // Reuse change-size-line to show a thin resize indicator alongside the freeze line
    const changeSizeLine = workbookContainer.querySelector(
        ".fortune-change-size-line"
    );
    if (changeSizeLine) {
        const ele = changeSizeLine as HTMLDivElement;
        ele.style.width = `${
            cellArea.getBoundingClientRect().width + scrollLeft
        }px`;
        ele.style.borderWidth = "0 0 1px 0";
        ele.style.top = `${row - 3}px`;
        ele.style.left = "0";
        ele.style.height = "1px";
    }
    e.stopPropagation();
}
