// The grid's clicks on cells. A mousedown selects a cell or a range, extends it with Shift, adds one with ⌘ or Ctrl,
// picks a reference while a formula is being typed, or does a painted glyph's job, such as ticking a tick box. A
// double click opens the cell editor, and a right click or a long press selects the cell and opens the context menu.
// A press that only closes an app-bar menu is swallowed while a formula is composed. The sheet overlay calls these
// from its DOM handlers; the drag that follows a press lives in its own file.

import { isNil, last } from 'es-toolkit/compat';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import {
    cellFocus,
    cellTextBox,
    checkboxChange,
    createFormulaRangeSelect,
    createRangeHightlight,
    deselectFloatingObject,
    functionHTMLGenerate,
    getCellDataValidation,
    isCheckboxClick,
    isDropdownChevronClick,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from '../modules';
import { cancelFunctionrangeSelected, mergeBorder, mergeMoveMain, updateCell } from '../modules/cell';
import { openCellEditor } from '../modules/cell-editor';
import type { CellGlyph } from '../modules/cell-glyph';
import { cellGlyphAt } from '../modules/cell-glyph';
import { getFilterButtonAtPosition } from '../modules/filter';
import { showLinkCard } from '../modules/hyperlink';
import { colLocation, colLocationByIndex, rowLocation, rowLocationByIndex, sheetPoint } from '../modules/location';
import { normalizeSelection } from '../modules/selection';
import type { GlobalCache } from '../types';
import { extendSelectionGeometry } from './mouse-drag';

// A glyph outranks the selection's drag handles, so a handle asks this before its mousedown starts a drag, outside a
// recipe. The press then bubbles to the cell area, whose handleCellAreaMouseDown does the glyph's job.
export function cellGlyphAtPointer(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement): CellGlyph | undefined {
    const { x, y, inside } = sheetPoint(ctx, e, cellArea);
    return inside ? cellGlyphAt(ctx, x, y) : undefined;
}

// Whether a press on a cell puts its reference into the formula being composed, rather than committing the edit.
function takesFormulaReference(ctx: Context): boolean {
    return (
        ctx.editingCellPosition.length > 0 &&
        Boolean(
            ctx.formulaCache.rangestart ||
                ctx.formulaCache.rangedrag_column_start ||
                ctx.formulaCache.rangedrag_row_start ||
                israngeseleciton(ctx),
        )
    );
}

// Swallows the press on the grid that only closes a menu while a formula waits for a reference, and returns whether it
// did. Like a reference press it keeps the browser from moving the focus out of the editor, which would put the caret
// back at the start.
export function swallowMenuPress(ctx: Context, globalCache: GlobalCache, e: MouseEvent): boolean {
    if (!globalCache.pressClosedMenu || !takesFormulaReference(ctx)) return false;
    e.preventDefault();
    return true;
}

// Returns true when the filter button consumed the click (the caller must then
// skip the cell-input focus, whose auto-scroll would close the just-opened menu).
export function handleCellAreaMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    ctx.filterContextMenu = undefined;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;
    if (swallowMenuPress(ctx, globalCache, e)) return;

    deselectFloatingObject(ctx);
    const { x, y, inside, pane } = sheetPoint(ctx, e, cellArea);
    if (!inside) return;

    // Canvas-drawn autofilter button: a plain left click opens the filter menu
    // anchored under the button; right/middle clicks fall through to selection.
    if (e.button === 0 && ctx.filterOptions != null) {
        const filterButton = getFilterButtonAtPosition(ctx, x, y);
        if (filterButton != null) {
            const { startRow, endRow, startCol, endCol } = ctx.filterOptions;
            ctx.filterContextMenu = {
                // Viewport-space anchor from the click's offset inside the button —
                // freeze-correct by construction (click and button share a region).
                x: e.clientX - (x - filterButton.left),
                y: e.clientY - (y - filterButton.top) + filterButton.height,
                col: filterButton.col,
                startRow,
                endRow,
                startCol,
                endCol,
            };
            // Keep the browser from focusing the overlay on this mousedown — that
            // focus shift would dismiss the just-opened menu via onFocusOutside.
            e.preventDefault();
            return true;
        }
    }

    let [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);
    let [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

    let row_index_ed = row_index;
    let col_index_ed = col_index;
    const margeset = mergeBorder(ctx, flowdata, row_index, col_index);
    if (margeset) {
        [row_pre, row, row_index, row_index_ed] = margeset.row;
        [col_pre, col, col_index, col_index_ed] = margeset.column;
    }

    showLinkCard(ctx, row_index, col_index, false, true);

    // The box the painter lays both data-validation glyphs out in.
    const textBox = cellTextBox(col_pre, row_pre, col, row);
    // While a cell edit is open the click belongs to the edit, so it fires no glyph. A toggle would write the cell and
    // recalculate behind the formula the user is still typing.
    const editing = ctx.editingCellPosition.length > 0;

    if (e.button !== 2 && !editing && isCheckboxClick(ctx, row_index, col_index, textBox, x, y)) {
        checkboxChange(ctx, row_index, col_index);
    }

    cellFocus(ctx, row_index, col_index);

    // cellFocus has just put the list's hidden anchor on this cell, and skips that when editing is not allowed, so a
    // read-only viewer sees the chevron but gets no list.
    if (
        e.button !== 2 &&
        !editing &&
        ctx.allowEdit !== false &&
        isDropdownChevronClick(ctx, row_index, col_index, textBox, x, y)
    ) {
        ctx.validationListOpen = true;
    }

    // A cell scrolled partly out of view scrolls back in, with one request for both axes.
    if (pane === 'main') {
        const request: { left?: number; top?: number } = {};
        if (col_pre < ctx.scrollLeft) {
            request.left = col_pre;
        }
        if (row_pre < ctx.scrollTop) {
            request.top = row_pre;
        }
        if (request.left != null || request.top != null) {
            ctx.scrollRequest = request;
        }
    }

    if (e.button === 2) {
        // A right-click inside the selection keeps it for the menu.
        if (inSelection(ctx, row_index, col_index)) return;
    }

    ctx.scrolling = true;

    if (ctx.editingCellPosition.length > 0) {
        if (takesFormulaReference(ctx)) {
            let rowSelected = [row_index, row_index_ed];
            let columnSelected = [col_index, col_index_ed];

            let left = col_pre;
            let width = col - col_pre - 1;
            let top = row_pre;
            let height = row - row_pre - 1;

            if (e.shiftKey) {
                const last = ctx.formulaCache.func_selectedrange;

                top = 0;
                height = 0;
                rowSelected = [];

                if (
                    last == null ||
                    last.top == null ||
                    last.height == null ||
                    last.row_focus == null ||
                    last.left == null ||
                    last.width == null
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
                rowSelected = rowGeom.selected;

                // The column axis can't use extendSelectionGeometry. Two of its arms need
                // last.column and last.column_focus and return without them, and the third doesn't.
                left = 0;
                width = 0;
                columnSelected = [];
                if (last.left > col_pre) {
                    left = col_pre;
                    width = last.left + last.width - col_pre;
                    if (last.column == null || last.column_focus == null) return;
                    if (last.column[1] > last.column_focus) {
                        last.column[1] = last.column_focus;
                    }

                    columnSelected = [col_index, last.column[1]];
                } else if (last.left === col_pre) {
                    left = col_pre;
                    width = last.left + last.width - col_pre;
                    columnSelected = [col_index, last.column[0]];
                } else {
                    left = last.left;
                    width = col - last.left - 1;
                    if (last.column == null || last.column_focus == null) return;

                    if (last.column[0] < last.column_focus) {
                        last.column[0] = last.column_focus;
                    }

                    columnSelected = [last.column[0], col_index];
                }

                const changeparam = mergeMoveMain(ctx, columnSelected, rowSelected, top, height, left, width);
                if (changeparam != null) {
                    [columnSelected, rowSelected, top, height, left, width] = changeparam;
                }

                last.row = rowSelected;
                last.column = columnSelected;

                last.left_move = left;
                last.width_move = width;
                last.top_move = top;
                last.height_move = height;

                ctx.formulaCache.func_selectedrange = last;
            } else if (e.ctrlKey && last(cellInput.querySelectorAll('span'))?.innerText !== ',') {
                // Ctrl held: finalize previous range
                let vText = cellInput.innerText;

                if (vText[vText.length - 1] === ')') {
                    vText = vText.substring(0, vText.length - 1); // Remove trailing closing parenthesis
                }

                if (vText.length > 0) {
                    const lastWord = vText.slice(-1);
                    if (lastWord !== ',' && lastWord !== '=' && lastWord !== '(') {
                        vText += ',';
                    }
                }
                if (vText.length > 0 && vText.substring(0, 1) === '=') {
                    vText = functionHTMLGenerate(vText);

                    cellInput.innerHTML = vText;

                    cancelFunctionrangeSelected(ctx);
                    createRangeHightlight(ctx, vText);
                }

                ctx.formulaCache.rangestart = false;
                ctx.formulaCache.rangedrag_column_start = false;
                ctx.formulaCache.rangedrag_row_start = false;

                if (fxInput) fxInput.innerHTML = vText;

                rangeHightlightselected(ctx, cellInput);

                israngeseleciton(ctx);
                ctx.formulaCache.func_selectedrange = {
                    left,
                    width,
                    top,
                    height,
                    left_move: left,
                    width_move: width,
                    top_move: top,
                    height_move: height,
                    row: rowSelected,
                    column: columnSelected,
                    row_focus: row_index,
                    column_focus: col_index,
                };
            } else {
                ctx.formulaCache.func_selectedrange = {
                    left,
                    width,
                    top,
                    height,
                    left_move: left,
                    width_move: width,
                    top_move: top,
                    height_move: height,
                    row: rowSelected,
                    column: columnSelected,
                    row_focus: row_index,
                    column_focus: col_index,
                };
            }

            rangeSetValue(
                ctx,
                cellInput,
                {
                    row: rowSelected,
                    column: columnSelected,
                },
                fxInput,
            );

            ctx.formulaCache.rangestart = true;
            ctx.formulaCache.rangedrag_column_start = false;
            ctx.formulaCache.rangedrag_row_start = false;

            const rangeIndex = ctx.formulaCache.rangechangeindex ?? 0;
            ctx.formulaCache.selectingRangeIndex = rangeIndex;
            if (rangeIndex > ctx.formulaRangeHighlight.length) {
                createRangeHightlight(ctx, cellInput.innerHTML, rangeIndex);
            }
            createFormulaRangeSelect(ctx, {
                rangeIndex,
                left,
                top,
                width,
                height,
            });
            e.preventDefault();
            return; // skip ctx.selections to prevent clearing cellInput
        }
        updateCell(ctx, ctx.editingCellPosition[0], ctx.editingCellPosition[1], cellInput);
    }
    ctx.selectionActive = true;

    if (e.shiftKey) {
        const last = ctx.selections?.[ctx.selections.length - 1];
        if (
            last &&
            last.top != null &&
            last.left != null &&
            last.height != null &&
            last.width != null &&
            last.row_focus != null &&
            last.column_focus != null
        ) {
            const rowGeom = extendSelectionGeometry(
                last.top,
                last.height,
                last.row,
                last.row_focus,
                row_pre,
                row,
                row_index,
            );
            let top = rowGeom.start;
            let height = rowGeom.span;
            let rowSelected = rowGeom.selected;
            const colGeom = extendSelectionGeometry(
                last.left,
                last.width,
                last.column,
                last.column_focus,
                col_pre,
                col,
                col_index,
            );
            let left = colGeom.start;
            let width = colGeom.span;
            let columnSelected = colGeom.selected;
            const changeparam = mergeMoveMain(ctx, columnSelected, rowSelected, top, height, left, width);
            if (changeparam != null) {
                [columnSelected, rowSelected, top, height, left, width] = changeparam;
            }
            last.row = rowSelected;
            last.column = columnSelected;
            last.left_move = left;
            last.width_move = width;
            last.top_move = top;
            last.height_move = height;
        }
    } else if (e.ctrlKey || e.metaKey) {
        // Cmd/Ctrl+click on a selected cell deselects it. A duplicate range would collide on the overlay's React key
        // and leave a stuck highlight until reload.
        const selections = ctx.selections;
        const overlapIndex = selections?.findIndex(
            (obj_s) =>
                row_index >= obj_s.row[0] &&
                row_index <= obj_s.row[1] &&
                col_index >= obj_s.column[0] &&
                col_index <= obj_s.column[1],
        );
        if (selections && overlapIndex != null && overlapIndex > -1) {
            // Keep at least one active selection; clicking inside the only one is a no-op
            if (selections.length > 1) selections.splice(overlapIndex, 1);
        } else {
            selections?.push({
                left: col_pre,
                width: col - col_pre - 1,
                top: row_pre,
                height: row - row_pre - 1,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [row_index, row_index_ed],
                column: [col_index, col_index_ed],
                row_focus: row_index,
                column_focus: col_index,
            });
        }
    } else {
        ctx.selections = [
            {
                left: col_pre,
                width: col - col_pre - 1,
                top: row_pre,
                height: row - row_pre - 1,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [row_index, row_index_ed],
                column: [col_index, col_index_ed],
                row_focus: row_index,
                column_focus: col_index,
            },
        ];
    }

    ctx.selections = normalizeSelection(ctx, ctx.selections);
}

export function handleCellAreaDoubleClick(ctx: Context, e: MouseEvent, cellArea: HTMLElement) {
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (
        (ctx.editingCellPosition.length > 0 && ctx.formulaCache.rangestart) ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start ||
        israngeseleciton(ctx)
    ) {
        return;
    }
    if (ctx.allowEdit === false) return;

    const { x, y } = sheetPoint(ctx, e, cellArea);

    // Double-clicking a filter button must not start editing the cell under it
    if (getFilterButtonAtPosition(ctx, x, y) != null) return;

    let row_index = rowLocation(y, ctx.visibledatarow)[2];
    let col_index = colLocation(x, ctx.visibledatacolumn)[2];

    // A tick-box cell changes only through a click on its box, so a double click opens no cell editor.
    if (getCellDataValidation(ctx, row_index, col_index)?.type === 'checkbox') return;

    const margeset = mergeBorder(ctx, flowdata, row_index, col_index);
    if (margeset) {
        [, , row_index] = margeset.row;
        [, , col_index] = margeset.column;
    }

    const focus = ctx.selections?.[0];
    const column_focus = focus?.column_focus;
    const row_focus = focus?.row_focus;
    if (!isNil(column_focus) && !isNil(row_focus) && (column_focus !== col_index || row_focus !== row_index)) {
        row_index = row_focus;
        col_index = column_focus;
    }

    openCellEditor(ctx, row_index, col_index, { caret: 'end' });
}

// True when a selection holds the cell at (row, column). A null row asks about a whole column, and a null column about a
// whole row, which a selection of whole rows or whole columns across it doesn't hold.
function inSelection(ctx: Context, row: number | null, column: number | null): boolean {
    return (
        ctx.selections?.some(
            (selection) =>
                (row == null ? !selection.row_select : row >= selection.row[0] && row <= selection.row[1]) &&
                (column == null
                    ? !selection.column_select
                    : column >= selection.column[0] && column <= selection.column[1]),
        ) ?? false
    );
}

// A real right click and a long press, which has no mouse event, select the same way.
type ContextMenuPoint = { clientX: number; clientY: number; metaKey?: boolean; ctrlKey?: boolean };

export function handleContextMenu(
    ctx: Context,
    point: ContextMenuPoint,
    cellArea: HTMLDivElement,
    area: 'cell' | 'rowHeader' | 'columnHeader',
) {
    if (!ctx.allowEdit) {
        return;
    }
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    const { x, y } = sheetPoint(ctx, point, cellArea);

    if (area === 'cell') {
        const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);
        const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);
        // A right-click inside the selection keeps it for the menu.
        const isInSelection = inSelection(ctx, row_index, col_index);
        if (!isInSelection && (point.metaKey || point.ctrlKey)) {
            if (flowdata[row_index][col_index]?.mc) {
                const changeparam = mergeMoveMain(
                    ctx,
                    [col_index, col_index],
                    [row_index, row_index],
                    row_pre,
                    row - row_pre - 1,
                    col_pre,
                    col - col_pre - 1,
                );
                if (changeparam != null) {
                    const [columnSelected, rowSelected, top, height, left, width] = changeparam;
                    ctx.selections?.push({
                        left,
                        width: width - 1,
                        top,
                        height: height - 1,
                        left_move: left,
                        width_move: width,
                        top_move: top,
                        height_move: height,
                        row: rowSelected,
                        column: columnSelected,
                        row_focus: rowSelected[0],
                        column_focus: columnSelected[0],
                    });
                    return;
                }
            }
            ctx.selections?.push({
                left: col_pre,
                width: col - col_pre - 1,
                top: row_pre,
                height: row - row_pre - 1,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [row_index, row_index],
                column: [col_index, col_index],
                row_focus: row_index,
                column_focus: col_index,
            });
            return;
        }
        if (isInSelection) return;
        const row_index_ed = row_index;
        const col_index_ed = col_index;
        if (flowdata[row_index][col_index]?.mc) {
            const changeparam = mergeMoveMain(
                ctx,
                [col_index, col_index],
                [row_index, row_index],
                row_pre,
                row - row_pre - 1,
                col_pre,
                col - col_pre - 1,
            );
            if (changeparam != null) {
                const [columnSelected, rowSelected, top, height, left, width] = changeparam;
                ctx.selections = [
                    {
                        left,
                        width: width - 1,
                        top,
                        height: height - 1,
                        left_move: left,
                        width_move: width,
                        top_move: top,
                        height_move: height,
                        row: rowSelected,
                        column: columnSelected,
                        row_focus: rowSelected[0],
                        column_focus: columnSelected[0],
                    },
                ];
                return;
            }
        }
        ctx.selections = [
            {
                left: col_pre,
                width: col - col_pre - 1,
                top: row_pre,
                height: row - row_pre - 1,
                left_move: col_pre,
                width_move: col - col_pre - 1,
                top_move: row_pre,
                height_move: row - row_pre - 1,
                row: [row_index, row_index_ed],
                column: [col_index, col_index_ed],
                row_focus: row_index,
                column_focus: col_index,
            },
        ];
    } else if (area === 'rowHeader') {
        const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);
        if (inSelection(ctx, row_index, null)) return;
        const col_index = ctx.visibledatacolumn.length - 1;
        const col = ctx.visibledatacolumn[col_index];
        const col_pre = 0;
        const top = row_pre;
        const height = row - row_pre - 1;
        const rowSelected = [row_index, row_index];
        ctx.selections = [];
        ctx.selections.push({
            left: colLocationByIndex(0, ctx.visibledatacolumn)[0],
            width:
                colLocationByIndex(0, ctx.visibledatacolumn)[1] - colLocationByIndex(0, ctx.visibledatacolumn)[0] - 1,
            top,
            height,
            left_move: col_pre,
            width_move: col - col_pre - 1,
            top_move: top,
            height_move: height,
            row: rowSelected,
            column: [0, col_index],
            row_focus: row_index,
            column_focus: 0,
            row_select: true,
        });
    } else if (area === 'columnHeader') {
        const row_index = ctx.visibledatarow.length - 1;
        const row = ctx.visibledatarow[row_index];
        const row_pre = 0;
        const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);
        if (inSelection(ctx, null, col_index)) return;
        const left = col_pre;
        const width = col - col_pre - 1;
        const columnSelected = [col_index, col_index];
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
            column: columnSelected,
            row_focus: 0,
            column_focus: col_index,
            column_select: true,
        });
    }
}
