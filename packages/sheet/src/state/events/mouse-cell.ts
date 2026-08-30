import { isNil, last } from 'es-toolkit/compat';
import { type Context, getFlowdata } from '../context';
import {
    cancelActiveImgItem,
    cellFocus,
    cellTextBox,
    checkboxChange,
    createFormulaRangeSelect,
    createRangeHightlight,
    functionHTMLGenerate,
    getCellDataVerification,
    isCheckboxClick,
    isDropdownChevronClick,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from '../modules';
import { cancelFunctionrangeSelected, mergeBorder, mergeMoveMain, setEditingCell, updateCell } from '../modules/cell';
import { type CellGlyph, cellGlyphAt } from '../modules/cell-glyph';
import { FILTER_BUTTON_HEIGHT, getFilterButtonAtPosition } from '../modules/filter';
import { showLinkCard } from '../modules/hyperlink';
import { colLocation, colLocationByIndex, rowLocation, rowLocationByIndex } from '../modules/location';
import { checkProtectionSelectLockedOrUnLockedCells } from '../modules/protection';
import { normalizeSelection } from '../modules/selection';
import type { Settings } from '../settings';
import type { GlobalCache } from '../types';
import { isAllowEdit } from '../utils';
import { extendSelectionGeometry } from './mouse-drag';
import { fixPositionOnFrozenCells } from './mouse-resize';

// The painted cell glyph under the pointer, if any — read off the live scroll in
// globalCache, the way the header hover does, so the selection's DOM drag
// handles can ask before their mousedown starts a drag, outside a recipe. A
// glyph outranks both handles: OverlayVisuals then leaves the press to bubble
// to the cell area, whose handleCellAreaMouseDown below does the glyph's job.
export function cellGlyphAtPointer(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
): CellGlyph | undefined {
    const rect = scrollEl.getBoundingClientRect();
    const mouseX = e.pageX - rect.left - window.scrollX;
    const mouseY = e.pageY - rect.top - window.scrollY;
    if (mouseX < 0 || mouseY < 0 || mouseX >= rect.width || mouseY >= rect.height) return undefined;
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x, y } = fixPositionOnFrozenCells(
        freeze,
        mouseX + globalCache.scrollLeft,
        mouseY + globalCache.scrollTop,
        mouseX,
        mouseY,
    );
    return cellGlyphAt(ctx, x, y);
}

// Returns true when the filter button consumed the click (the caller must then
// skip the cell-input focus, whose auto-scroll would close the just-opened menu).
export function handleCellAreaMouseDown(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
    canvas?: CanvasRenderingContext2D,
) {
    ctx.filterContextMenu = undefined;
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    cancelActiveImgItem(ctx, globalCache);
    const rect = container.getBoundingClientRect();
    const mouseX = e.pageX - rect.left - window.scrollX;
    const mouseY = e.pageY - rect.top - window.scrollY;
    const _x = mouseX + ctx.scrollLeft;
    const _y = mouseY + ctx.scrollTop;
    if (_x >= rect.width + ctx.scrollLeft || _y >= rect.height + ctx.scrollTop) {
        return;
    }
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x, y, inHorizontalFreeze, inVerticalFreeze } = fixPositionOnFrozenCells(freeze, _x, _y, mouseX, mouseY);

    // Canvas-drawn autofilter button: a plain left click opens the filter menu
    // anchored under the button; right/middle clicks fall through to selection.
    if (e.button === 0 && ctx.filterOptions != null) {
        const filterButton = getFilterButtonAtPosition(ctx, x, y);
        if (filterButton != null) {
            const { startRow, endRow, startCol, endCol } = ctx.filterOptions;
            ctx.filterContextMenu = {
                // Viewport-space anchor from the click's offset inside the button —
                // freeze-correct by construction (click and button share a region).
                x: rect.left + mouseX - (x - filterButton.left),
                y: rect.top + mouseY - (y - filterButton.top) + FILTER_BUTTON_HEIGHT,
                col: filterButton.col,
                startRow,
                endRow,
                startCol,
                endCol,
                hiddenRows: Object.keys(ctx.filter[filterButton.col - startCol]?.rowhidden ?? {}).map((r) =>
                    parseInt(r, 10),
                ),
            };
            // Keep the browser from focusing the overlay on this mousedown — that
            // focus shift would dismiss the just-opened menu via onFocusOutside.
            e.preventDefault();
            return true;
        }
    }

    const row_location = rowLocation(y, ctx.visibledatarow);
    let row = row_location[1];
    let row_pre = row_location[0];
    let row_index = row_location[2];

    const col_location = colLocation(x, ctx.visibledatacolumn);
    let col = col_location[1];
    let col_pre = col_location[0];
    let col_index = col_location[2];

    let row_index_ed = row_index;
    let col_index_ed = col_index;
    const margeset = mergeBorder(ctx, flowdata, row_index, col_index);
    if (margeset) {
        [row_pre, row, row_index, row_index_ed] = margeset.row;
        [col_pre, col, col_index, col_index_ed] = margeset.column;
    }

    showLinkCard(ctx, row_index, col_index, false, true);
    // Before cell mousedown hook
    if (
        ctx.hooks.beforeCellMouseDown?.(flowdata[row_index]?.[col_index], {
            row: row_index,
            column: col_index,
            startRow: row_pre,
            startColumn: col_pre,
            endRow: row,
            endColumn: col,
        }) === false
    ) {
        return;
    }

    // The cell's text area, the space both data-verification affordances are
    // laid out in — the same box, from the same builder, the canvas painter
    // hands their geometry.
    const textBox = cellTextBox(col_pre, row_pre, col, row);
    // While a cell edit is open the click belongs to the edit: it inserts the
    // cell's reference into the formula being composed, or commits the value.
    // Neither may also fire an affordance — a toggle mid-edit writes the cell
    // and recalculates behind the formula the user is still typing. The
    // keyboard path (events/keyboard.ts) bails on the same condition.
    const editing = ctx.editingCellPosition.length > 0;

    if (e.button !== 2 && !editing && isCheckboxClick(ctx, row_index, col_index, textBox, x, y)) {
        checkboxChange(ctx, row_index, col_index);
    }

    // Data verification: cell focus
    cellFocus(ctx, row_index, col_index);

    // A click on the painted list chevron opens the dropdown in one go, the way
    // the canvas filter button opens its menu. cellFocus has just positioned the
    // hidden Radix anchor on this cell — and skips that when editing is not
    // allowed, so a read-only viewer sees the chevron but gets no list.
    if (
        e.button !== 2 &&
        !editing &&
        isAllowEdit(ctx) &&
        isDropdownChevronClick(ctx, row_index, col_index, textBox, x, y)
    ) {
        ctx.dataVerificationDropDownList = true;
    }

    // If clicked cell is not in viewport, request a programmatic scroll to reveal
    // it (one request for both axes); the read compares against the live mirror.
    if (!inHorizontalFreeze && !inVerticalFreeze) {
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

    // Right-click handling
    if (e.button === 2) {
        // If right-click is inside selection, stop mousedown handling
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.row != null &&
                row_index >= obj_s.row[0] &&
                row_index <= obj_s.row[1] &&
                col_index >= obj_s.column[0] &&
                col_index <= obj_s.column[1],
        );
        if (isInSelection) return;
    }

    ctx.scrolling = true;

    // Formula-related
    if (ctx.editingCellPosition.length > 0) {
        if (
            ctx.formulaCache.rangestart ||
            ctx.formulaCache.rangedrag_column_start ||
            ctx.formulaCache.rangedrag_row_start ||
            israngeseleciton(ctx)
        ) {
            // Formula range selection
            let rowseleted = [row_index, row_index_ed];
            let columnseleted = [col_index, col_index_ed];

            let left = col_pre;
            let width = col - col_pre - 1;
            let top = row_pre;
            let height = row - row_pre - 1;

            if (e.shiftKey) {
                const last = ctx.formulaCache.func_selectedrange;

                top = 0;
                height = 0;
                rowseleted = [];

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
                rowseleted = rowGeom.selected;

                // Column axis kept inline: unlike the other copies this site guards
                // `last.column` / `last.column_focus` lazily inside two arms (the
                // preamble above only null-checks the row fields), so an early
                // `return` here can't be expressed through extendSelectionGeometry.
                left = 0;
                width = 0;
                columnseleted = [];
                if (last.left > col_pre) {
                    left = col_pre;
                    width = last.left + last.width - col_pre;
                    if (last.column == null || last.column_focus == null) return;
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
                    if (last.column == null || last.column_focus == null) return;

                    if (last.column[0] < last.column_focus) {
                        last.column[0] = last.column_focus;
                    }

                    columnseleted = [last.column[0], col_index];
                }

                const changeparam = mergeMoveMain(ctx, columnseleted, rowseleted, last, top, height, left, width);
                if (changeparam != null) {
                    [columnseleted, rowseleted, top, height, left, width] = changeparam;
                }

                last.row = rowseleted;
                last.column = columnseleted;

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
                    const lastWord = vText.substring(vText.length - 1, 1);
                    if (lastWord !== ',' && lastWord !== '=' && lastWord !== '(') {
                        vText += ',';
                    }
                }
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

                    /* Re-add closing parenthesis before display */
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
                    left,
                    width,
                    top,
                    height,
                    left_move: left,
                    width_move: width,
                    top_move: top,
                    height_move: height,
                    row: rowseleted,
                    column: columnseleted,
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
                    row: rowseleted,
                    column: columnseleted,
                    row_focus: row_index,
                    column_focus: col_index,
                };
            }

            rangeSetValue(
                ctx,
                cellInput,
                {
                    row: rowseleted,
                    column: columnseleted,
                },
                fxInput,
            );

            ctx.formulaCache.rangestart = true;
            ctx.formulaCache.rangedrag_column_start = false;
            ctx.formulaCache.rangedrag_row_start = false;

            ctx.formulaCache.selectingRangeIndex = ctx.formulaCache.rangechangeindex!;
            if (ctx.formulaCache.rangechangeindex! > ctx.formulaRangeHighlight.length) {
                createRangeHightlight(ctx, cellInput.innerHTML, ctx.formulaCache.rangechangeindex!);
            }
            createFormulaRangeSelect(ctx, {
                rangeIndex: ctx.formulaCache.rangechangeindex || 0,
                left,
                top,
                width,
                height,
            });
            e.preventDefault();
            return; // skip ctx.selections to prevent clearing cellInput
        }
        updateCell(ctx, ctx.editingCellPosition[0], ctx.editingCellPosition[1], cellInput, undefined, canvas);
        ctx.selectionActive = true;
    }
    if (checkProtectionSelectLockedOrUnLockedCells(ctx, row_index, col_index, ctx.currentSheetId)) {
        ctx.selectionActive = true;
    }

    if (ctx.selectionActive) {
        if (e.shiftKey) {
            // Shift+click: select range
            const last = ctx.selections?.[ctx.selections.length - 1]; // last selection
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
                let rowseleted = rowGeom.selected;
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
                let columnseleted = colGeom.selected;
                const changeparam = mergeMoveMain(ctx, columnseleted, rowseleted, last, top, height, left, width);
                if (changeparam != null) {
                    [columnseleted, rowseleted, top, height, left, width] = changeparam;
                }
                last.row = rowseleted;
                last.column = columnseleted;
                last.left_move = left;
                last.width_move = width;
                last.top_move = top;
                last.height_move = height;
                ctx.selections![ctx.selections!.length - 1] = last;
            }
        } else if (e.ctrlKey || e.metaKey) {
            // Cmd/Ctrl+click a cell that's already selected toggles it off (deselect),
            // matching Excel/Sheets. Pushing a duplicate range instead would collide on
            // the overlay's React key and orphan a stuck highlight div until reload.
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
            // eslint-disable-next-line prefer-const
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

            // Update cell format icon
        }
    }

    ctx.selections = normalizeSelection(ctx, ctx.selections);

    if (ctx.hooks.afterCellMouseDown) {
        setTimeout(() => {
            ctx.hooks.afterCellMouseDown?.(flowdata[row_index]?.[col_index], {
                row: row_index,
                column: col_index,
                startRow: row_pre,
                startColumn: col_pre,
                endRow: row,
                endColumn: col,
            });
        });
    }
}

export function handleCellAreaDoubleClick(
    ctx: Context,
    globalCache: GlobalCache,
    _settings: Settings,
    e: MouseEvent,
    container: HTMLElement,
) {
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
    // Editing disabled (view only)
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.pageX - rect.left;
    const mouseY = e.pageY - rect.top;
    const _x = mouseX + ctx.scrollLeft;
    const _y = mouseY + ctx.scrollTop;

    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x, y } = fixPositionOnFrozenCells(freeze, _x, _y, mouseX, mouseY);

    // Double-clicking a filter button must not start editing the cell under it
    if (getFilterButtonAtPosition(ctx, x, y) != null) return;

    const row_location = rowLocation(y, ctx.visibledatarow);
    let row_index = row_location[2];

    const col_location = colLocation(x, ctx.visibledatacolumn);
    let col_index = col_location[2];

    // Cancel double-click for checkbox cells -- do not allow editing
    if (getCellDataVerification(ctx, row_index, col_index)?.type === 'checkbox') return;

    const margeset = mergeBorder(ctx, flowdata, row_index, col_index);
    if (margeset) {
        [, , row_index] = margeset.row;
        [, , col_index] = margeset.column;
    }

    // Check if current and focus coordinates match; correct if not
    const { column_focus, row_focus } = ctx.selections![0];
    if (!isNil(column_focus) && !isNil(row_focus) && (column_focus !== col_index || row_focus !== row_index)) {
        row_index = row_focus;
        col_index = column_focus;
    }

    setEditingCell(ctx, row_index, col_index);
}

// Coords-plus-modifiers shape so both a real right-click (MouseEvent) and a long-press (touch,
// synthetic point) can drive the same select-cell-then-open flow. The caller preventDefaults.
type ContextMenuPoint = { pageX: number; pageY: number; metaKey?: boolean; ctrlKey?: boolean };

export function handleContextMenu(
    ctx: Context,
    point: ContextMenuPoint,
    container: HTMLDivElement,
    area: 'cell' | 'rowHeader' | 'columnHeader',
) {
    if (!ctx.allowEdit) {
        return;
    }
    const flowdata = getFlowdata(ctx);
    if (!flowdata) return;

    if (area === 'cell') {
        const rect = container.getBoundingClientRect();
        const mouseX = point.pageX - rect.left - window.scrollX;
        const mouseY = point.pageY - rect.top - window.scrollY;
        const _selected_x = mouseX + ctx.scrollLeft;
        const _selected_y = mouseY + ctx.scrollTop;
        const { x: selected_x, y: selected_y } = fixPositionOnFrozenCells(
            ctx.getRefs().globalCache.freezen?.[ctx.currentSheetId],
            _selected_x,
            _selected_y,
            mouseX,
            mouseY,
        );
        const row_location = rowLocation(selected_y, ctx.visibledatarow);
        const row = row_location[1];
        const row_pre = row_location[0];
        const row_index = row_location[2];

        const col_location = colLocation(selected_x, ctx.visibledatacolumn);
        const col = col_location[1];
        const col_pre = col_location[0];
        const col_index = col_location[2];
        // If right-click is inside selection, skip selection handling
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.row != null &&
                row_index >= obj_s.row[0] &&
                row_index <= obj_s.row[1] &&
                col_index >= obj_s.column[0] &&
                col_index <= obj_s.column[1],
        );
        if (!isInSelection && (point.metaKey || point.ctrlKey)) {
            // Add to selection
            if (flowdata[row_index][col_index]?.mc) {
                // Handle merged cell
                const changeparam = mergeMoveMain(
                    ctx,
                    [col_index, col_index],
                    [row_index, row_index],
                    { row_focus: row_index, column_focus: col_index },
                    row_pre,
                    row,
                    col_pre,
                    col,
                );
                if (changeparam != null) {
                    const [columnseleted, rowseleted, top, height, left, width] = changeparam;
                    ctx.selections?.push({
                        left,
                        width: width - 1,
                        top,
                        height: height - 1,
                        left_move: left,
                        width_move: width,
                        top_move: top,
                        height_move: height,
                        row: rowseleted,
                        column: columnseleted,
                        row_focus: rowseleted[0],
                        column_focus: columnseleted[0],
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
            // Handle merged cell
            const changeparam = mergeMoveMain(
                ctx,
                [col_index, col_index],
                [row_index, row_index],
                { row_focus: row_index, column_focus: col_index },
                row_pre,
                row,
                col_pre,
                col,
            );
            if (changeparam != null) {
                const [columnseleted, rowseleted, top, height, left, width] = changeparam;
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
                        row: rowseleted,
                        column: columnseleted,
                        row_focus: rowseleted[0],
                        column_focus: columnseleted[0],
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
        const rect = container.getBoundingClientRect();
        const mouseY = point.pageY - rect.top - window.scrollY;
        const _selected_y = mouseY + ctx.scrollTop;
        const { y: selected_y } = fixPositionOnFrozenCells(
            ctx.getRefs().globalCache.freezen?.[ctx.currentSheetId],
            0,
            _selected_y,
            0,
            mouseY,
        );
        const row_location = rowLocation(selected_y, ctx.visibledatarow);
        const row = row_location[1];
        const row_pre = row_location[0];
        const row_index = row_location[2];
        // If right-click is inside selection, skip selection handling
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.row != null && row_index >= obj_s.row[0] && row_index <= obj_s.row[1] && !obj_s.column_select,
        );

        if (isInSelection) return;
        const col_index = ctx.visibledatacolumn.length - 1;
        const col = ctx.visibledatacolumn[col_index];
        const col_pre = 0;
        const top = row_pre;
        const height = row - row_pre - 1;
        const rowseleted = [row_index, row_index];
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
            row: rowseleted,
            column: [0, col_index],
            row_focus: row_index,
            column_focus: 0,
            row_select: true,
        });
    } else if (area === 'columnHeader') {
        const rect = container.getBoundingClientRect();
        const mouseX = point.pageX - rect.left - window.scrollX;
        const _selected_x = mouseX + ctx.scrollLeft;
        const { x: selected_x } = fixPositionOnFrozenCells(
            ctx.getRefs().globalCache.freezen?.[ctx.currentSheetId],
            _selected_x,
            0,
            mouseX,
            0,
        );
        const row_index = ctx.visibledatarow.length - 1;
        const row = ctx.visibledatarow[row_index];
        const row_pre = 0;
        const col_location = colLocation(selected_x, ctx.visibledatacolumn);
        const col = col_location[1];
        const col_pre = col_location[0];
        const col_index = col_location[2];
        // If right-click is inside selection, skip selection handling
        const isInSelection = ctx.selections?.some(
            (obj_s) =>
                obj_s.row != null && col_index >= obj_s.column[0] && col_index <= obj_s.column[1] && !obj_s.row_select,
        );

        if (isInSelection) return;
        const left = col_pre;
        const width = col - col_pre - 1;
        const columnseleted = [col_index, col_index];
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
    }
}
