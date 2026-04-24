import {cloneDeep, indexOf, isEmpty, isNil, last} from "es-toolkit/compat";
import {Context, getFlowdata} from "../context";
import {
    cancelActiveImgItem,
    createFormulaRangeSelect,
    createRangeHightlight,
    functionHTMLGenerate,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from "../modules";
import {
    cancelFunctionrangeSelected,
    mergeMoveMain,
    updateCell,
} from "../modules/cell";
import {colLocation, colLocationByIndex, rowLocation, rowLocationByIndex} from "../modules/location";
import {checkProtectionAllSelected} from "../modules/protection";
import {GlobalCache} from "../types";
import {fixPositionOnFrozenCells} from "./mouse-resize";

export function handleRowHeaderMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    container: HTMLDivElement,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null
) {
    if (!checkProtectionAllSelected(ctx, ctx.currentSheetId)) {
        return;
    }
    // Cancel active image item
    cancelActiveImgItem(ctx, globalCache);

    const rect = container.getBoundingClientRect();
    const mouseY = e.pageY - rect.top - window.scrollY;
    const _y = mouseY + ctx.scrollTop;

    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const {y} = fixPositionOnFrozenCells(freeze, 0, _y, 0, mouseY);

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];
    const row_pre = row_location[0];
    const row_index = row_location[2];
    const col_index = ctx.visibledatacolumn.length - 1;
    const col = ctx.visibledatacolumn[col_index];
    const col_pre = 0;

    // Right-click: check if inside existing selection
    if (e.button === 2) {
        // If right-click is inside selection, stop mousedown handling
        const flowdata = getFlowdata(ctx);
        const isInSelection = ctx.luckysheet_select_save?.some(
            (obj_s) =>
                obj_s.row != null &&
                row_index >= obj_s.row[0] &&
                row_index <= obj_s.row[1] &&
                obj_s.column[0] === 0 &&
                obj_s.column[1] === (flowdata?.[0]?.length ?? 0) - 1
        );
        if (isInSelection) return;
    }

    let top = row_pre;
    let height = row - row_pre - 1;
    let rowseleted = [row_index, row_index];

    ctx.luckysheet_scroll_status = true;

    // Formula-related
    if (!isEmpty(ctx.luckysheetCellUpdate)) {
        if (
            ctx.formulaCache.rangestart ||
            ctx.formulaCache.rangedrag_column_start ||
            ctx.formulaCache.rangedrag_row_start ||
            israngeseleciton(ctx)
        ) {
            // Formula range selection
            let changeparam = mergeMoveMain(
                ctx,
                [0, col_index],
                rowseleted,
                {row_focus: row_index, column_focus: 0},
                top,
                height,
                col_pre,
                col
            );
            if (changeparam != null) {
                // @ts-ignore
                [rowseleted, top, height] = [
                    changeparam[1],
                    changeparam[2],
                    changeparam[3],
                ];
            }

            if (e.shiftKey) {
                const last = ctx.formulaCache.func_selectedrange;

                top = 0;
                height = 0;
                rowseleted = [];
                if (
                    last == null ||
                    last.top == null ||
                    last.height == null ||
                    last.row == null ||
                    last.row_focus == null
                )
                    return;
                if (last.top > row_pre) {
                    top = row_pre;
                    height = last.top + last.height - row_pre;

                    if (last.row[1] > last.row_focus) {
                        last.row[1] = last.row_focus;
                    }

                    rowseleted = [row_index, last.row[1]];
                } else if (last.top === row_pre) {
                    top = row_pre;
                    height = last.top + last.height - row_pre;
                    rowseleted = [row_index, last.row[0]];
                } else {
                    top = last.top;
                    height = row - last.top - 1;

                    if (last.row[0] < last.row_focus) {
                        last.row[0] = last.row_focus;
                    }

                    rowseleted = [last.row[0], row_index];
                }

                changeparam = mergeMoveMain(
                    ctx,
                    [0, col_index],
                    rowseleted,
                    {row_focus: row_index, column_focus: 0},
                    top,
                    height,
                    col_pre,
                    col
                );
                if (changeparam != null) {
                    // @ts-ignore
                    [rowseleted, top, height] = [
                        changeparam[1],
                        changeparam[2],
                        changeparam[3],
                    ];
                }

                last.row = rowseleted;

                last.top_move = top;
                last.height_move = height;

                ctx.formulaCache.func_selectedrange = last;
            } else if (
                e.ctrlKey &&
                last(cellInput.querySelectorAll("span"))?.innerText !== ","
            ) {
                // Ctrl held: finalize previous range selection first
                let vText = `${cellInput.innerText},`;
                if (vText.length > 0 && vText.substring(0, 1) === "=") {
                    vText = functionHTMLGenerate(vText);

                    if (window.getSelection) {
                        // All browsers except IE before version 9
                        const currSelection = window.getSelection();
                        if (currSelection == null) return;
                        ctx.formulaCache.functionRangeIndex = [
                            indexOf(
                                currSelection.anchorNode?.parentNode?.parentNode?.childNodes,
                                // @ts-ignore
                                currSelection.anchorNode?.parentNode
                            ),
                            currSelection.anchorOffset,
                        ];
                    } else {
                        // Internet Explorer before version 9
                        // @ts-ignore
                        const textRange = document.selection.createRange();
                        ctx.formulaCache.functionRangeIndex = textRange;
                    }

                    cellInput.innerHTML = vText;
                    cancelFunctionrangeSelected(ctx);
                    createRangeHightlight(ctx, vText);
                }

                ctx.formulaCache.rangestart = false;
                ctx.formulaCache.rangedrag_column_start = false;
                ctx.formulaCache.rangedrag_row_start = false;

                if (fxInput) fxInput.innerHTML = vText;

                rangeHightlightselected(ctx, cellInput);

                // Then proceed with new range selection
                israngeseleciton(ctx);
                ctx.formulaCache.func_selectedrange = {
                    left: colLocationByIndex(0, ctx.visibledatacolumn)[0],
                    width:
                        colLocationByIndex(0, ctx.visibledatacolumn)[1] -
                        colLocationByIndex(0, ctx.visibledatacolumn)[0] -
                        1,
                    top,
                    height,
                    left_move: col_pre,
                    width_move: col - col_pre - 1,
                    top_move: top,
                    height_move: height,
                    row: rowseleted,
                    column: [0, col_index],
                    row_focus: row_index,
                    column_focus: 0,
                };
            } else {
                ctx.formulaCache.func_selectedrange = {
                    left: colLocationByIndex(0, ctx.visibledatacolumn)[0],
                    width:
                        colLocationByIndex(0, ctx.visibledatacolumn)[1] -
                        colLocationByIndex(0, ctx.visibledatacolumn)[0] -
                        1,
                    top,
                    height,
                    left_move: col_pre,
                    width_move: col - col_pre - 1,
                    top_move: top,
                    height_move: height,
                    row: rowseleted,
                    column: [0, col_index],
                    row_focus: row_index,
                    column_focus: 0,
                };
            }

            if (
                ctx.formulaCache.rangestart ||
                ctx.formulaCache.rangedrag_column_start ||
                ctx.formulaCache.rangedrag_row_start ||
                israngeseleciton(ctx)
            ) {
                rangeSetValue(
                    ctx,
                    cellInput,
                    {
                        row: rowseleted,
                        column: [null, null],
                    },
                    fxInput
                );
            }

            ctx.formulaCache.rangedrag_row_start = true;
            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_column_start = false;

            ctx.formulaCache.selectingRangeIndex = ctx.formulaCache.rangechangeindex!;
            if (
                ctx.formulaCache.rangechangeindex! > ctx.formulaRangeHighlight.length
            ) {
                createRangeHightlight(
                    ctx,
                    cellInput.innerHTML,
                    ctx.formulaCache.rangechangeindex!
                );
            }
            createFormulaRangeSelect(ctx, {
                rangeIndex: ctx.formulaCache.rangechangeindex || 0,
                left: col_pre,
                top,
                width: col - col_pre - 1,
                height,
            });
            e.preventDefault();

            return;
        }

        updateCell(
            ctx,
            ctx.luckysheetCellUpdate[0],
            ctx.luckysheetCellUpdate[1],
            cellInput
        );
        ctx.luckysheet_rows_selected_status = true;
    } else {
        ctx.luckysheet_rows_selected_status = true;
    }

    if (ctx.luckysheet_rows_selected_status) {
        if (e.shiftKey) {
            // Shift+click on row header to select range
            const last = cloneDeep(
                ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1]
            ); // Last selection
            if (
                !last ||
                isNil(last.top) ||
                isNil(last.height) ||
                isNil(last.row_focus)
            ) {
                return;
            }

            let _top = 0;
            let _height = 0;
            let _rowseleted = [];
            if (last.top > row_pre) {
                _top = row_pre;
                _height = last.top + last.height - row_pre;

                if (last.row[1] > last.row_focus) {
                    last.row[1] = last.row_focus;
                }

                _rowseleted = [row_index, last.row[1]];
            } else if (last.top === row_pre) {
                _top = row_pre;
                _height = last.top + last.height - row_pre;
                _rowseleted = [row_index, last.row[0]];
            } else {
                _top = last.top;
                _height = row - last.top - 1;

                if (last.row[0] < last.row_focus) {
                    last.row[0] = last.row_focus;
                }

                _rowseleted = [last.row[0], row_index];
            }

            last.row = _rowseleted;

            last.top_move = _top;
            last.height_move = _height;

            ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1] =
                last;
        } else if (e.ctrlKey || e.metaKey) {
            ctx.luckysheet_select_save?.push({
                left: colLocationByIndex(0, ctx.visibledatacolumn)[0],
                width:
                    colLocationByIndex(0, ctx.visibledatacolumn)[1] -
                    colLocationByIndex(0, ctx.visibledatacolumn)[0] -
                    1,
                top,
                height,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: top,
                height_move: height,
                row: rowseleted,
                column: [0, col_index],
                row_focus: row_index,
                column_focus: 0,
                row_select: true,
            });
        } else {
            ctx.luckysheet_select_save = [];
            ctx.luckysheet_select_save.push({
                left: colLocationByIndex(0, ctx.visibledatacolumn)[0],
                width:
                    colLocationByIndex(0, ctx.visibledatacolumn)[1] -
                    colLocationByIndex(0, ctx.visibledatacolumn)[0] -
                    1,
                top,
                height,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: top,
                height_move: height,
                row: rowseleted,
                column: [0, col_index],
                row_focus: row_index,
                column_focus: 0,
                row_select: true,
            });
            /**
             * Set ctx.luckysheet_select_status = true so that the mouse can continue
             * selecting while held down.
             * Set ctx.luckysheet_scroll_status = true to allow scrollbar movement
             * during multi-select.
             * When luckysheet_select_status is true, mouseRender in mouse.ts executes.
             */
            ctx.luckysheet_select_status = true;
            ctx.luckysheet_scroll_status = true;
        }
    }
}

export function handleColumnHeaderMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    container: HTMLElement,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null
) {
    if (!checkProtectionAllSelected(ctx, ctx.currentSheetId)) {
        return;
    }
    // Cancel active image item
    cancelActiveImgItem(ctx, globalCache);

    const rect = container.getBoundingClientRect();
    const mouseX = e.pageX - rect.left - window.scrollX;
    const _x = mouseX + ctx.scrollLeft;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const {x} = fixPositionOnFrozenCells(freeze, _x, 0, mouseX, 0);

    const row_index = ctx.visibledatarow.length - 1;
    const row = ctx.visibledatarow[row_index];
    const row_pre = 0;
    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];
    const col_pre = col_location[0];
    const col_index = col_location[2];

    ctx.orderbyindex = col_index; // Global sort index

    // Right-click: check if inside existing selection
    if (e.button === 2) {
        const flowdata = getFlowdata(ctx);
        const isInSelection = ctx.luckysheet_select_save?.some(
            (obj_s) =>
                obj_s.column != null &&
                col_index >= obj_s.column[0] &&
                col_index <= obj_s.column[1] &&
                obj_s.row[0] === 0 &&
                obj_s.row[1] === (flowdata?.length ?? 0) - 1
        );
        if (isInSelection) return;
    }

    let left = col_pre;
    let width = col - col_pre - 1;
    let columnseleted = [col_index, col_index];

    ctx.luckysheet_scroll_status = true;

    // Formula-related
    if (!isEmpty(ctx.luckysheetCellUpdate)) {
        if (
            ctx.formulaCache.rangestart ||
            ctx.formulaCache.rangedrag_column_start ||
            ctx.formulaCache.rangedrag_row_start ||
            israngeseleciton(ctx)
        ) {
            // Formula range selection
            let changeparam = mergeMoveMain(
                ctx,
                columnseleted,
                [0, row_index],
                {row_focus: 0, column_focus: col_index},
                row_pre,
                row,
                left,
                width
            );
            if (changeparam != null) {
                // @ts-ignore
                [columnseleted, left, width] = [
                    changeparam[0],
                    changeparam[4],
                    changeparam[5],
                ];
            }

            if (e.shiftKey) {
                const last = ctx.formulaCache.func_selectedrange;

                left = 0;
                width = 0;
                columnseleted = [];
                if (
                    last == null ||
                    last.width == null ||
                    last.height == null ||
                    last.left == null ||
                    last.column_focus == null
                )
                    return;
                if (last.left > col_pre) {
                    left = col_pre;
                    width = last.left + last.width - col_pre;

                    if (last.column[1] > last.column_focus) {
                        last.column[1] = last.column_focus;
                    }

                    columnseleted = [col_index, last.column[1]];
                } else if (last.left === col_pre) {
                    left = col_pre;
                    width = last.left + last.width - col_pre;
                    columnseleted = [col_index, last.column[0]];
                } else {
                    left = last.left;
                    width = col - last.left - 1;

                    if (last.column[0] < last.column_focus) {
                        last.column[0] = last.column_focus;
                    }

                    columnseleted = [last.column[0], col_index];
                }

                changeparam = mergeMoveMain(
                    ctx,
                    columnseleted,
                    [0, row_index],
                    {row_focus: 0, column_focus: col_index},
                    row_pre,
                    row,
                    left,
                    width
                );
                if (changeparam != null) {
                    // @ts-ignore
                    [columnseleted, left, width] = [
                        changeparam[0],
                        changeparam[4],
                        changeparam[5],
                    ];
                }

                last.column = columnseleted;

                last.left_move = left;
                last.width_move = width;

                ctx.formulaCache.func_selectedrange = last;
            } else if (
                e.ctrlKey &&
                last(cellInput.querySelectorAll("span"))?.innerText !== ","
            ) {
                // Ctrl held: finalize previous range selection first
                let vText = `${cellInput.innerText},`;
                if (vText.length > 0 && vText.substring(0, 1) === "=") {
                    vText = functionHTMLGenerate(vText);

                    if (window.getSelection) {
                        // All browsers except IE before version 9
                        const currSelection = window.getSelection();
                        if (currSelection == null) return;
                        ctx.formulaCache.functionRangeIndex = [
                            indexOf(
                                currSelection.anchorNode?.parentNode?.parentNode?.childNodes,
                                // @ts-ignore
                                currSelection.anchorNode?.parentNode
                            ),
                            currSelection.anchorOffset,
                        ];
                    } else {
                        // Internet Explorer before version 9
                        // @ts-ignore
                        const textRange = document.selection.createRange();
                        ctx.formulaCache.functionRangeIndex = textRange;
                    }

                    cellInput.innerHTML = vText;

                    cancelFunctionrangeSelected(ctx);
                    createRangeHightlight(ctx, vText);
                }

                ctx.formulaCache.rangestart = false;
                ctx.formulaCache.rangedrag_column_start = false;
                ctx.formulaCache.rangedrag_row_start = false;

                if (fxInput) {
                    fxInput.innerHTML = vText;
                }
                rangeHightlightselected(ctx, cellInput);

                // Then proceed with new range selection
                israngeseleciton(ctx);
                ctx.formulaCache.func_selectedrange = {
                    left,
                    width,
                    top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                    height:
                        rowLocationByIndex(0, ctx.visibledatarow)[1] -
                        rowLocationByIndex(0, ctx.visibledatarow)[0] -
                        1,
                    left_move: left,
                    width_move: width,
                    top_move: row_pre,
                    height_move: row - row_pre - 1,
                    row: [0, row_index],
                    column: columnseleted,
                    row_focus: 0,
                    column_focus: col_index,
                };
            } else {
                ctx.formulaCache.func_selectedrange = {
                    left,
                    width,
                    top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                    height:
                        rowLocationByIndex(0, ctx.visibledatarow)[1] -
                        rowLocationByIndex(0, ctx.visibledatarow)[0] -
                        1,
                    left_move: left,
                    width_move: width,
                    top_move: row_pre,
                    height_move: row - row_pre - 1,
                    row: [0, row_index],
                    column: columnseleted,
                    row_focus: 0,
                    column_focus: col_index,
                };
            }

            if (
                ctx.formulaCache.rangestart ||
                ctx.formulaCache.rangedrag_column_start ||
                ctx.formulaCache.rangedrag_row_start ||
                israngeseleciton(ctx)
            ) {
                rangeSetValue(
                    ctx,
                    cellInput,
                    {
                        row: [null, null],
                        column: columnseleted,
                    },
                    fxInput
                );
            }

            ctx.formulaCache.rangedrag_column_start = true;
            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_row_start = false;

            ctx.formulaCache.selectingRangeIndex = ctx.formulaCache.rangechangeindex!;
            if (
                ctx.formulaCache.rangechangeindex! > ctx.formulaRangeHighlight.length
            ) {
                createRangeHightlight(
                    ctx,
                    cellInput.innerHTML,
                    ctx.formulaCache.rangechangeindex!
                );
            }
            createFormulaRangeSelect(ctx, {
                rangeIndex: ctx.formulaCache.rangechangeindex || 0,
                left,
                top: row_pre,
                width,
                height: row - row_pre - 1,
            });
            e.preventDefault();

            return;
        }
        updateCell(
            ctx,
            ctx.luckysheetCellUpdate[0],
            ctx.luckysheetCellUpdate[1],
            cellInput
        );
        ctx.luckysheet_cols_selected_status = true;
    } else {
        ctx.luckysheet_cols_selected_status = true;
    }

    if (ctx.luckysheet_cols_selected_status) {
        if (e.shiftKey) {
            // Shift+click on column header to select range
            const last = cloneDeep(
                ctx.luckysheet_select_save?.[ctx.luckysheet_select_save.length - 1]
            ); // Last selection

            let _left = 0;
            let _width = 0;
            let _columnseleted = [];

            if (
                !last ||
                isNil(last.left) ||
                isNil(last.width) ||
                isNil(last.column_focus)
            ) {
                return;
            }

            if (last.left > col_pre) {
                _left = col_pre;
                _width = last.left + last.width - col_pre;

                if (last.column[1] > last.column_focus) {
                    last.column[1] = last.column_focus;
                }

                _columnseleted = [col_index, last.column[1]];
            } else if (last.left === col_pre) {
                _left = col_pre;
                _width = last.left + last.width - col_pre;
                _columnseleted = [col_index, last.column[0]];
            } else {
                _left = last.left;
                _width = col - last.left - 1;

                if (last.column[0] < last.column_focus) {
                    last.column[0] = last.column_focus;
                }

                _columnseleted = [last.column[0], col_index];
            }

            last.column = _columnseleted;

            last.left_move = _left;
            last.width_move = _width;

            ctx.luckysheet_select_save![ctx.luckysheet_select_save!.length - 1] =
                last;
        } else if (e.ctrlKey || e.metaKey) {
            // Add to selection
            ctx.luckysheet_select_save?.push({
                left,
                width,
                top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                height:
                    rowLocationByIndex(0, ctx.visibledatarow)[1] -
                    rowLocationByIndex(0, ctx.visibledatarow)[0] -
                    1,
                left_move: left,
                width_move: width,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [0, row_index],
                column: columnseleted,
                row_focus: 0,
                column_focus: col_index,
                column_select: true,
            });
        } else {
            ctx.luckysheet_select_save = [];
            ctx.luckysheet_select_save.push({
                left,
                width,
                top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                height:
                    rowLocationByIndex(0, ctx.visibledatarow)[1] -
                    rowLocationByIndex(0, ctx.visibledatarow)[0] -
                    1,
                left_move: left,
                width_move: width,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [0, row_index],
                column: columnseleted,
                row_focus: 0,
                column_focus: col_index,
                column_select: true,
            });
            /**
             * Set ctx.luckysheet_select_status = true so that the mouse can continue
             * selecting while held down.
             * Set ctx.luckysheet_scroll_status = true to allow scrollbar movement
             * during multi-select.
             * When luckysheet_select_status is true, mouseRender in mouse.ts executes.
             */
            ctx.luckysheet_select_status = true;
            ctx.luckysheet_scroll_status = true;
        }
    }
}
