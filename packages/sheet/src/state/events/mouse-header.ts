import { cloneDeep, isEmpty, isNil, last } from 'es-toolkit/compat';
import { type Context, getFlowdata } from '../context';
import {
    cancelActiveImgItem,
    createFormulaRangeSelect,
    createRangeHightlight,
    functionHTMLGenerate,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from '../modules';
import { cancelFunctionrangeSelected, mergeMoveMain, updateCell } from '../modules/cell';
import { colLocation, colLocationByIndex, rowLocation, rowLocationByIndex } from '../modules/location';
import { checkProtectionAllSelected } from '../modules/protection';
import type { GlobalCache } from '../types';
import { extendSelectionGeometry } from './mouse-drag';
import { fixPositionOnFrozenCells } from './mouse-resize';

export function handleRowHeaderMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    container: HTMLDivElement,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null,
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
    const { y } = fixPositionOnFrozenCells(freeze, 0, _y, 0, mouseY);

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
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.row != null &&
                row_index >= obj_s.row[0] &&
                row_index <= obj_s.row[1] &&
                obj_s.column[0] === 0 &&
                obj_s.column[1] === (flowdata?.[0]?.length ?? 0) - 1,
        );
        if (isInSelection) return;
    }

    let top = row_pre;
    let height = row - row_pre - 1;
    let rowseleted = [row_index, row_index];

    ctx.scrolling = true;

    // Formula-related
    if (!isEmpty(ctx.editingCellPosition)) {
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
                { row_focus: row_index, column_focus: 0 },
                top,
                height,
                col_pre,
                col,
            );
            if (changeparam != null) {
                [rowseleted, top, height] = [changeparam[1], changeparam[2], changeparam[3]];
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
                const rowGeom = extendSelectionGeometry(
                    last.top,
                    last.height,
                    last.row,
                    last.row_focus,
                    row_pre,
                    row,
                    row_index,
                );
                top = rowGeom.start;
                height = rowGeom.span;
                rowseleted = rowGeom.selected;

                changeparam = mergeMoveMain(
                    ctx,
                    [0, col_index],
                    rowseleted,
                    { row_focus: row_index, column_focus: 0 },
                    top,
                    height,
                    col_pre,
                    col,
                );
                if (changeparam != null) {
                    [rowseleted, top, height] = [changeparam[1], changeparam[2], changeparam[3]];
                }

                last.row = rowseleted;

                last.top_move = top;
                last.height_move = height;

                ctx.formulaCache.func_selectedrange = last;
            } else if (e.ctrlKey && last(cellInput.querySelectorAll('span'))?.innerText !== ',') {
                // Ctrl held: finalize previous range selection first
                let vText = `${cellInput.innerText},`;
                if (vText.length > 0 && vText.substring(0, 1) === '=') {
                    vText = functionHTMLGenerate(vText);

                    const currSelection = window.getSelection();
                    if (currSelection == null) return;
                    // `parentNode` resolves to `ParentNode | null` in lib.dom while childNodes are
                    // `ChildNode`; widening to `Node` lets indexOf match the same DOM reference.
                    const anchorParent: Node | null = currSelection.anchorNode?.parentNode ?? null;
                    const siblings = anchorParent?.parentNode?.childNodes;
                    const rangeIndex = anchorParent && siblings ? Array.from<Node>(siblings).indexOf(anchorParent) : -1;
                    ctx.formulaCache.functionRangeIndex = [rangeIndex, currSelection.anchorOffset];

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
                    fxInput,
                );
            }

            ctx.formulaCache.rangedrag_row_start = true;
            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_column_start = false;

            ctx.formulaCache.selectingRangeIndex = ctx.formulaCache.rangechangeindex!;
            if (ctx.formulaCache.rangechangeindex! > ctx.formulaRangeHighlight.length) {
                createRangeHightlight(ctx, cellInput.innerHTML, ctx.formulaCache.rangechangeindex!);
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

        updateCell(ctx, ctx.editingCellPosition[0], ctx.editingCellPosition[1], cellInput);
        ctx.rowsSelected = true;
    } else {
        ctx.rowsSelected = true;
    }

    if (ctx.rowsSelected) {
        if (e.shiftKey) {
            // Shift+click on row header to select range
            const last = cloneDeep(ctx.selections?.[ctx.selections.length - 1]); // Last selection
            if (!last || isNil(last.top) || isNil(last.height) || isNil(last.row_focus)) {
                return;
            }

            let _top = 0;
            let _height = 0;
            let _rowseleted = [];
            const rowGeom = extendSelectionGeometry(
                last.top,
                last.height,
                last.row,
                last.row_focus,
                row_pre,
                row,
                row_index,
            );
            _top = rowGeom.start;
            _height = rowGeom.span;
            _rowseleted = rowGeom.selected;

            last.row = _rowseleted;

            last.top_move = _top;
            last.height_move = _height;

            ctx.selections![ctx.selections!.length - 1] = last;
        } else if (e.ctrlKey || e.metaKey) {
            ctx.selections?.push({
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
            ctx.selections = [];
            ctx.selections.push({
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
            ctx.selectionActive = true;
            ctx.scrolling = true;
        }
    }
}

export function handleColumnHeaderMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    container: HTMLElement,
    cellInput: HTMLDivElement,
    fxInput: HTMLDivElement | null,
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
    const { x } = fixPositionOnFrozenCells(freeze, _x, 0, mouseX, 0);

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
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.column != null &&
                col_index >= obj_s.column[0] &&
                col_index <= obj_s.column[1] &&
                obj_s.row[0] === 0 &&
                obj_s.row[1] === (flowdata?.length ?? 0) - 1,
        );
        if (isInSelection) return;
    }

    let left = col_pre;
    let width = col - col_pre - 1;
    let columnseleted = [col_index, col_index];

    ctx.scrolling = true;

    // Formula-related
    if (!isEmpty(ctx.editingCellPosition)) {
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
                { row_focus: 0, column_focus: col_index },
                row_pre,
                row,
                left,
                width,
            );
            if (changeparam != null) {
                [columnseleted, left, width] = [changeparam[0], changeparam[4], changeparam[5]];
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
                const colGeom = extendSelectionGeometry(
                    last.left,
                    last.width,
                    last.column,
                    last.column_focus,
                    col_pre,
                    col,
                    col_index,
                );
                left = colGeom.start;
                width = colGeom.span;
                columnseleted = colGeom.selected;

                changeparam = mergeMoveMain(
                    ctx,
                    columnseleted,
                    [0, row_index],
                    { row_focus: 0, column_focus: col_index },
                    row_pre,
                    row,
                    left,
                    width,
                );
                if (changeparam != null) {
                    [columnseleted, left, width] = [changeparam[0], changeparam[4], changeparam[5]];
                }

                last.column = columnseleted;

                last.left_move = left;
                last.width_move = width;

                ctx.formulaCache.func_selectedrange = last;
            } else if (e.ctrlKey && last(cellInput.querySelectorAll('span'))?.innerText !== ',') {
                // Ctrl held: finalize previous range selection first
                let vText = `${cellInput.innerText},`;
                if (vText.length > 0 && vText.substring(0, 1) === '=') {
                    vText = functionHTMLGenerate(vText);

                    const currSelection = window.getSelection();
                    if (currSelection == null) return;
                    // `parentNode` resolves to `ParentNode | null` in lib.dom while childNodes are
                    // `ChildNode`; widening to `Node` lets indexOf match the same DOM reference.
                    const anchorParent: Node | null = currSelection.anchorNode?.parentNode ?? null;
                    const siblings = anchorParent?.parentNode?.childNodes;
                    const rangeIndex = anchorParent && siblings ? Array.from<Node>(siblings).indexOf(anchorParent) : -1;
                    ctx.formulaCache.functionRangeIndex = [rangeIndex, currSelection.anchorOffset];

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
                        rowLocationByIndex(0, ctx.visibledatarow)[1] - rowLocationByIndex(0, ctx.visibledatarow)[0] - 1,
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
                        rowLocationByIndex(0, ctx.visibledatarow)[1] - rowLocationByIndex(0, ctx.visibledatarow)[0] - 1,
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
                    fxInput,
                );
            }

            ctx.formulaCache.rangedrag_column_start = true;
            ctx.formulaCache.rangestart = false;
            ctx.formulaCache.rangedrag_row_start = false;

            ctx.formulaCache.selectingRangeIndex = ctx.formulaCache.rangechangeindex!;
            if (ctx.formulaCache.rangechangeindex! > ctx.formulaRangeHighlight.length) {
                createRangeHightlight(ctx, cellInput.innerHTML, ctx.formulaCache.rangechangeindex!);
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
        updateCell(ctx, ctx.editingCellPosition[0], ctx.editingCellPosition[1], cellInput);
        ctx.colsSelected = true;
    } else {
        ctx.colsSelected = true;
    }

    if (ctx.colsSelected) {
        if (e.shiftKey) {
            // Shift+click on column header to select range
            const last = cloneDeep(ctx.selections?.[ctx.selections.length - 1]); // Last selection

            let _left = 0;
            let _width = 0;
            let _columnseleted = [];

            if (!last || isNil(last.left) || isNil(last.width) || isNil(last.column_focus)) {
                return;
            }

            const colGeom = extendSelectionGeometry(
                last.left,
                last.width,
                last.column,
                last.column_focus,
                col_pre,
                col,
                col_index,
            );
            _left = colGeom.start;
            _width = colGeom.span;
            _columnseleted = colGeom.selected;

            last.column = _columnseleted;

            last.left_move = _left;
            last.width_move = _width;

            ctx.selections![ctx.selections!.length - 1] = last;
        } else if (e.ctrlKey || e.metaKey) {
            // Add to selection
            ctx.selections?.push({
                left,
                width,
                top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                height: rowLocationByIndex(0, ctx.visibledatarow)[1] - rowLocationByIndex(0, ctx.visibledatarow)[0] - 1,
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
            ctx.selections = [];
            ctx.selections.push({
                left,
                width,
                top: rowLocationByIndex(0, ctx.visibledatarow)[0],
                height: rowLocationByIndex(0, ctx.visibledatarow)[1] - rowLocationByIndex(0, ctx.visibledatarow)[0] - 1,
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
            ctx.selectionActive = true;
            ctx.scrolling = true;
        }
    }
}
