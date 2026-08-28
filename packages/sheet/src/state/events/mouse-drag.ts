import { cloneDeep, isNil } from 'es-toolkit/compat';
import type { Context } from '../context';
import {
    cancelPaintModel,
    onCellsMove,
    onCellsMoveEnd,
    onFormulaRangeDragEnd,
    onImageMove,
    onImageMoveEnd,
    rangeDrag,
} from '../modules';
import { mergeMoveMain } from '../modules/cell';
import { onDropCellSelect, onDropCellSelectEnd } from '../modules/drop-cell';
import { getFilterButtonAtPosition } from '../modules/filter';
import { handleFormulaInput } from '../modules/formula-editor';
import { rangeDragColumn, rangeDragRow } from '../modules/formula-range';
import { getFrozenHandleLeft, getFrozenHandleTop, scrollToFrozenRowCol } from '../modules/freeze';
import { colLocation, rowLocation } from '../modules/location';
import { checkProtectionSelectLockedOrUnLockedCells } from '../modules/protection';
import { pasteHandlerOfPaintModel } from '../modules/selection';
import type { Settings } from '../settings';
import type { GlobalCache } from '../types';
import { getSheetIndex } from '../utils';
import { fixPositionOnFrozenCells } from './mouse-resize';

// Shift-click / drag selection extension along a single axis (row or column).
// The classic luckysheet motif, previously pasted across the mouse layer
// (mouse-cell / mouse-drag / mouse-header): given the anchor selection's start
// (`pos`) and span, plus the newly hit cell's near edge (`pre`), far edge (`end`)
// and index, it returns the extended axis start/span and the new [start, end]
// index pair. It clamps the anchor's index `range` toward its `focus` in place —
// the same side effect the inlined copies had on `last.row` / `last.column`.
export function extendSelectionGeometry(
    pos: number,
    span: number,
    range: number[],
    focus: number,
    pre: number,
    end: number,
    index: number,
): { start: number; span: number; selected: number[] } {
    if (pos > pre) {
        if (range[1] > focus) {
            range[1] = focus;
        }
        return { start: pre, span: pos + span - pre, selected: [index, range[1]] };
    }
    if (pos === pre) {
        return { start: pre, span: pos + span - pre, selected: [index, range[0]] };
    }
    if (range[0] < focus) {
        range[0] = focus;
    }
    return { start: pos, span: end - pos - 1, selected: [range[0], index] };
}

// ---------------------------------------------------------------------------
// mouseRender sub-functions (private)
// ---------------------------------------------------------------------------

function renderCellSelection(ctx: Context, globalCache: GlobalCache, e: MouseEvent, container: HTMLDivElement) {
    const rect = container.getBoundingClientRect();
    const mouseX = e.pageX - rect.left - window.scrollX;
    const mouseY = e.pageY - rect.top - window.scrollY;
    const _x = mouseX - ctx.rowHeaderWidth + ctx.scrollLeft;
    const _y = mouseY - ctx.columnHeaderHeight + ctx.scrollTop;

    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x, y } = fixPositionOnFrozenCells(
        freeze,
        _x,
        _y,
        mouseX - ctx.rowHeaderWidth,
        mouseY - ctx.columnHeaderHeight,
    );

    const row_location = rowLocation(y, ctx.visibledatarow);
    const row = row_location[1];
    const row_pre = row_location[0];
    const row_index = row_location[2];
    const col_location = colLocation(x, ctx.visibledatacolumn);
    const col = col_location[1];
    const col_pre = col_location[0];
    const col_index = col_location[2];

    if (!checkProtectionSelectLockedOrUnLockedCells(ctx, row_index, col_index, ctx.currentSheetId)) {
        ctx.selectionActive = false;
        return;
    }

    const last = cloneDeep(ctx.selections?.[ctx.selections.length - 1]);

    if (
        !last ||
        isNil(last.left) ||
        isNil(last.top) ||
        isNil(last.height) ||
        isNil(last.width) ||
        isNil(last.row_focus) ||
        isNil(last.column_focus)
    ) {
        return;
    }

    const rowGeom = extendSelectionGeometry(last.top, last.height, last.row, last.row_focus, row_pre, row, row_index);
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

    // Check if selecting entire row
    const isMaxColumn = ctx.selections![ctx.selections!.length - 1].column;
    const colMax = ctx.visibledatacolumn.length - 1;
    if (isMaxColumn![0] === 0 && isMaxColumn![1] === colMax) {
        last.column[1] = colMax;
        last.width_move = ctx.visibledatacolumn[colMax] - 1;
    }

    // Check if selecting entire column
    const isMaxRow = ctx.selections![ctx.selections!.length - 1].row;
    const rowMax = ctx.visibledatarow.length - 1;
    if (isMaxRow![0] === 0 && isMaxRow![1] === rowMax) {
        last.row[1] = rowMax;
        last.height_move = ctx.visibledatarow[rowMax] - 1;
    }

    ctx.selections![ctx.selections!.length - 1] = last;

    scrollToFrozenRowCol(ctx, globalCache.freezen?.[ctx.currentSheetId]);
}

function renderColResize(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollEl.scrollLeft - window.scrollX;
    if (x < rect.width + ctx.scrollLeft - 100) {
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine) {
            (changeSizeLine as HTMLDivElement).style.left = `${x}px`;
        }
        // The header handle lives in the pane region of the resized column:
        // live-translated main coordinates normally, pinned frozen-band
        // coordinates when that column is frozen.
        const vData = globalCache.freezen?.[ctx.currentSheetId]?.vertical?.freezenverticaldata;
        const inFreeze = vData != null && ctx.colsResizeStart[1] < vData.boundary;
        const handleX = inFreeze ? x - scrollEl.scrollLeft + vData.scroll : x;
        const changeSizeCol = container.querySelector('.sheet-cols-change-size');
        if (changeSizeCol) {
            (changeSizeCol as HTMLDivElement).style.left = `${handleX - 2}px`;
        }
    }
}

function renderRowResize(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
) {
    const rect = container.getBoundingClientRect();
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollEl.scrollTop - window.scrollY;
    if (y < rect.height + ctx.scrollTop - 20) {
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine) {
            (changeSizeLine as HTMLDivElement).style.top = `${y}px`;
        }
        // Same pane-region mapping as renderColResize, on the row axis. The -2
        // preserves the view position the handle had inside the old header
        // content frame (shifted up 2px by the header's negative margin).
        const hData = globalCache.freezen?.[ctx.currentSheetId]?.horizontal?.freezenhorizontaldata;
        const inFreeze = hData != null && ctx.rowsResizeStart[1] < hData.boundary;
        const handleY = inFreeze ? y - scrollEl.scrollTop + hData.scroll : y;
        const changeSizeRow = container.querySelector('.sheet-rows-change-size');
        if (changeSizeRow) {
            (changeSizeRow as HTMLDivElement).style.top = `${handleY - 2}px`;
        }
    }
}

function renderColFreezeDrag(ctx: Context, e: MouseEvent, container: HTMLDivElement) {
    const rect = container.getBoundingClientRect();
    const x = e.pageX - rect.left - ctx.rowHeaderWidth + ctx.scrollLeft - window.scrollX;
    const [col_pre, col_curr] = colLocation(x, ctx.visibledatacolumn);

    const col = x > (col_pre + col_curr) / 2 ? col_curr : col_pre;

    if (x < rect.width + ctx.scrollLeft - 100) {
        const freezeLine = container.querySelector('.sheet-freeze-drag-line');
        if (freezeLine) {
            (freezeLine as HTMLDivElement).style.left = `${Math.max(0, col - 2)}px`;
        }
        const freezeHandle = container.querySelector('.sheet-cols-freeze-handle');
        if (freezeHandle) {
            (freezeHandle as HTMLDivElement).style.left = `${x}px`;
        }
        // reuse change-size-line
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine) {
            (changeSizeLine as HTMLDivElement).style.left = `${x}px`;
        }
    }
}

function renderRowFreezeDrag(ctx: Context, e: MouseEvent, container: HTMLDivElement) {
    const rect = container.getBoundingClientRect();
    const y = e.pageY - rect.top - ctx.columnHeaderHeight + ctx.scrollTop - window.scrollY;
    const [row_pre, row_curr] = rowLocation(y, ctx.visibledatarow);

    const row = y > (row_curr + row_pre) / 2 ? row_curr : row_pre;

    if (y < rect.height + ctx.scrollTop - 20) {
        const freezeLine = container.querySelector('.sheet-freeze-drag-line');
        if (freezeLine) {
            (freezeLine as HTMLDivElement).style.top = `${Math.max(0, row - 2)}px`;
        }
        const freezeHandle = container.querySelector('.sheet-rows-freeze-handle');
        if (freezeHandle) {
            (freezeHandle as HTMLDivElement).style.top = `${y}px`;
        }
        // reuse change-size-line
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine) {
            (changeSizeLine as HTMLDivElement).style.top = `${y}px`;
        }
    }
}

// ---------------------------------------------------------------------------
// mouseRender — thin dispatcher (private)
// ---------------------------------------------------------------------------

function mouseRender(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    const rect = container.getBoundingClientRect();

    // Auto-scroll when dragging near edges
    if (ctx.scrolling && !ctx.colsResizing && !ctx.rowsResizing) {
        const left = ctx.scrollLeft;
        const top = ctx.scrollTop;
        const x = e.pageX - rect.left - window.scrollX;
        const y = e.pageY - rect.top - window.scrollY;
        const winH = rect.height - 20;
        const winW = rect.width - 60;

        if (y < 0 || y > winH) {
            let stop: number;
            if (y < 0) {
                stop = top + y / 2;
            } else {
                stop = top + (y - winH) / 2;
            }
            scrollEl.scrollTop = stop;
        }

        if (x < 0 || x > winW) {
            let sleft: number;
            if (x < 0) {
                sleft = left + x / 2;
            } else {
                sleft = left + (x - winW) / 2;
            }

            scrollEl.scrollLeft = sleft;
        }
    }

    // Check if range dialog is in single-select mode
    if (ctx.rangeDialog?.singleSelect) {
        return;
    }

    // Drag selection
    if (ctx.selectionActive) {
        renderCellSelection(ctx, globalCache, e, container);
    } else if (ctx.formulaCache.rangestart) {
        rangeDrag(ctx, e, cellInput, scrollEl.scrollLeft, scrollEl.scrollTop, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_row_start) {
        rangeDragRow(ctx, e, cellInput, scrollEl.scrollLeft, scrollEl.scrollTop, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_column_start) {
        rangeDragColumn(ctx, e, cellInput, scrollEl.scrollLeft, scrollEl.scrollTop, container, fxInput);
    } else if (ctx.rowsSelected) {
        // Row selection drag — not yet implemented
    } else if (ctx.colsSelected) {
        // Column selection drag — not yet implemented
    } else if (ctx.cellSelectMoving) {
        // Cell move drag — not yet implemented
    } else if (ctx.cellSelectExtending) {
        onDropCellSelect(ctx, e, scrollEl, container);
    } else if (ctx.colsResizing) {
        // Column width resize drag
        renderColResize(ctx, globalCache, e, scrollEl, container);
    } else if (ctx.rowsResizing) {
        // Row height resize drag
        renderRowResize(ctx, globalCache, e, scrollEl, container);
    } else if (ctx.colsFreezeDragging) {
        // Column freeze drag
        renderColFreezeDrag(ctx, e, container);
    } else if (ctx.rowsFreezeDragging) {
        // Row freeze drag
        renderRowFreezeDrag(ctx, e, container);
    }
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

// Track which canvas-drawn filter button the pointer is over; written only on
// change so idle mousemoves stay redraw-free. The matching pointer cursor and
// hover fill read ctx.filterButtonHover.
function updateFilterButtonHover(ctx: Context, globalCache: GlobalCache, e: MouseEvent, scrollEl: HTMLDivElement) {
    const setHover = (col: number | undefined) => {
        if (ctx.filterButtonHover !== col) ctx.filterButtonHover = col;
    };
    if (ctx.filterOptions == null) {
        setHover(undefined);
        return;
    }
    const rect = scrollEl.getBoundingClientRect();
    const mouseX = e.pageX - rect.left - window.scrollX;
    const mouseY = e.pageY - rect.top - window.scrollY;
    // Document-level listener: outside the cell area the scroll-shifted sheet
    // coordinates below would be meaningless and could phantom-hit a button.
    if (mouseX < 0 || mouseY < 0 || mouseX >= rect.width || mouseY >= rect.height) {
        setHover(undefined);
        return;
    }
    const freeze = globalCache.freezen?.[ctx.currentSheetId];
    const { x, y } = fixPositionOnFrozenCells(freeze, mouseX + ctx.scrollLeft, mouseY + ctx.scrollTop, mouseX, mouseY);
    setHover(getFilterButtonAtPosition(ctx, x, y)?.col);
}

export function handleOverlayMouseMove(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    if (onImageMove(ctx, globalCache, e)) return;
    onCellsMove(ctx, globalCache, e, scrollEl, container);

    if (!ctx.selectionActive && !ctx.scrolling) {
        updateFilterButtonHover(ctx, globalCache, e, scrollEl);
    }

    if (
        ctx.scrolling ||
        ctx.selectionActive ||
        ctx.rowsSelected ||
        ctx.colsSelected ||
        ctx.cellSelectMoving ||
        ctx.cellSelectExtending ||
        ctx.colsResizing ||
        ctx.rowsResizing
    ) {
        mouseRender(ctx, globalCache, e, cellInput, scrollEl, container, fxInput);
    }
}

export function handleOverlayMouseUp(
    ctx: Context,
    globalCache: GlobalCache,
    _settings: Settings,
    e: MouseEvent,
    scrollEl: HTMLDivElement,
    container: HTMLDivElement,
    cellInput: HTMLDivElement | null,
    fxInput: HTMLDivElement | null,
) {
    const rect = container.getBoundingClientRect();
    onImageMoveEnd(ctx, globalCache);
    onFormulaRangeDragEnd(ctx);
    onCellsMoveEnd(ctx, globalCache, e, scrollEl, container);
    if (
        ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start
    ) {
        if (document.activeElement?.id === 'sheet-functionbox-cell') {
            handleFormulaInput(ctx, cellInput!, fxInput!, 0, undefined, false);
        } else {
            handleFormulaInput(ctx, fxInput, cellInput!, 0, undefined, false);
        }
    }

    // Main data pane
    if (ctx.selectionActive) {
        // Format painter
        if (ctx.formatPainterOn) {
            pasteHandlerOfPaintModel(ctx, ctx.copyState);
            if (ctx.formatPainterOnce) {
                // Single-use format painter
                cancelPaintModel(ctx);
            }
        }
    }

    ctx.selectionActive = false;
    ctx.scrolling = false;

    // Row header pane
    ctx.rowsSelected = false;

    // Column header pane
    ctx.colsSelected = false;

    ctx.modalDragging = false;

    // Change row height
    if (ctx.rowsResizing) {
        ctx.rowsResizing = false;

        const { scrollTop } = ctx;
        const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop - window.scrollY;
        const winH = rect.height;

        let delta = y + 3 - ctx.rowsResizeStart[0];

        if (y >= winH - 20 + scrollTop) {
            delta = winH - 20 - ctx.rowsResizeStart[0] + scrollTop;
        }

        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;

        let size = ctx.defaultrowlen;

        if (ctx.visibledatarow[ctx.rowsResizeStart[1]] != null) {
            size = ctx.visibledatarow[ctx.rowsResizeStart[1]] - (ctx.visibledatarow[ctx.rowsResizeStart[1] - 1] || 0);
        }

        const firstrowlen = size;

        size += delta;

        // Sub-3px is a mis-click, not a resize — bail before seeding the maps below, or every
        // stray click would ship an empty rowlen/customHeight op. Mirrors the column path.
        if (Math.abs(size - firstrowlen) < 3) {
            return;
        }
        if (size < 10) {
            size = 10;
        }

        const cfg = (ctx.sheets[idx].config ??= {});
        cfg.rowlen ??= {};
        cfg.customHeight ??= {};
        cfg.customHeight[ctx.rowsResizeStart[1]] = 1;

        const changeRowIndex = ctx.rowsResizeStart[1];
        let changeRowSelected = false;
        if ((ctx.selections?.length ?? 0) > 0) {
            ctx.selections
                ?.filter((select) => select.row_select)
                ?.some((select) => {
                    if (changeRowIndex >= select.row[0] && changeRowIndex <= select.row[1]) {
                        changeRowSelected = true;
                    }
                    return changeRowSelected;
                });
        }
        if (changeRowSelected) {
            cfg.rowlen ||= {};
            for (const select of ctx.selections?.filter((select) => select.row_select) ?? []) {
                for (let r = select.row[0]; r <= select.row[1]; r += 1) {
                    cfg.rowlen![r] = Math.ceil(size);
                }
            }
        } else {
            cfg.rowlen[ctx.rowsResizeStart[1]] = Math.ceil(size);
        }
    }

    // Change column width
    if (ctx.colsResizing) {
        ctx.colsResizing = false;

        const { scrollLeft } = ctx;
        const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft - window.scrollX;
        const winW = rect.width;

        let delta = x + 3 - ctx.colsResizeStart[0];

        if (x >= winW - 100 + scrollLeft) {
            delta = winW - 100 - ctx.colsResizeStart[0] + scrollLeft;
        }

        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;
        const columnlen = ctx.sheets[idx].config?.columnlen;

        let firstcolumnlen = ctx.defaultcollen;
        if (columnlen?.[ctx.colsResizeStart[1]] != null) {
            firstcolumnlen = columnlen[ctx.colsResizeStart[1]];
        }

        let size = (columnlen?.[ctx.colsResizeStart[1]] || ctx.defaultcollen) + delta;

        // Sub-3px is a mis-click, not a resize — bail before seeding the maps below, or
        // every stray click would ship an empty columnlen/customWidth op.
        if (Math.abs(size - firstcolumnlen) < 3) {
            return;
        }
        if (size < 10) {
            size = 10;
        }

        const cfg = (ctx.sheets[idx].config ??= {});
        cfg.columnlen ??= {};
        cfg.customWidth ??= {};
        cfg.customWidth[ctx.colsResizeStart[1]] = 1;

        const changeColumnIndex = ctx.colsResizeStart[1];
        let changeColumnSelected = false;
        if ((ctx.selections?.length ?? 0) > 0) {
            ctx.selections
                ?.filter((select) => select.column_select)
                ?.some((select) => {
                    if (changeColumnIndex >= select.column[0] && changeColumnIndex <= select.column[1]) {
                        changeColumnSelected = true;
                    }
                    return changeColumnSelected;
                });
        }
        if (changeColumnSelected) {
            for (const select of ctx.selections?.filter((select) => select.column_select) ?? []) {
                for (let r = select.column[0]; r <= select.column[1]; r += 1) {
                    cfg.columnlen[r] = Math.ceil(size);
                }
            }
        } else {
            cfg.columnlen[ctx.colsResizeStart[1]] = Math.ceil(size);
        }
    }

    // Column freeze drag end
    if (ctx.colsFreezeDragging) {
        ctx.colsFreezeDragging = false;

        const { scrollLeft } = ctx;
        const x = e.pageX - rect.left - ctx.rowHeaderWidth + scrollLeft - window.scrollX;
        const [col_pre, col_curr, col_index_curr] = colLocation(x, ctx.visibledatacolumn);
        const col_index = x > (col_curr + col_pre) / 2 ? col_index_curr : col_index_curr - 1;
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;
        if (col_index < 0) {
            const { frozen } = ctx.sheets[idx];
            if (frozen) {
                if (frozen.type === 'rangeBoth' || frozen.type === 'both') {
                    frozen.type = 'rangeRow';
                } else if (frozen.type === 'column' || frozen.type === 'rangeColumn') {
                    delete ctx.sheets[idx].frozen;
                }
            }
            const freezeHandle = container.querySelector('.sheet-cols-freeze-handle') as HTMLDivElement;
            if (freezeHandle) {
                freezeHandle.style.left = `${ctx.scrollLeft}px`;
            }
        } else if (!ctx.sheets[idx].frozen) {
            ctx.sheets[idx].frozen = {
                type: 'rangeColumn',
                range: { column_focus: col_index, row_focus: 0 },
            };
        } else {
            const frozen = ctx.sheets[idx].frozen!;
            if (!frozen.range) {
                frozen.range = { column_focus: col_index, row_focus: 0 };
            } else {
                frozen.range.column_focus = col_index;
            }
            if (frozen?.type === 'rangeRow' || frozen?.type === 'row') {
                frozen.type = 'rangeBoth';
            }
        }
        const freezeHandle = container.querySelector('.sheet-cols-freeze-handle') as HTMLDivElement;
        if (freezeHandle) {
            freezeHandle.style.left = `${getFrozenHandleLeft(ctx)}px`;
        }
    }

    // Row freeze drag end
    if (ctx.rowsFreezeDragging) {
        ctx.rowsFreezeDragging = false;

        const { scrollTop } = ctx;
        const y = e.pageY - rect.top - ctx.columnHeaderHeight + scrollTop - window.scrollY;
        const [row_pre, row_curr, row_index_curr] = rowLocation(y, ctx.visibledatarow);
        const row_index = y > (row_curr + row_pre) / 2 ? row_index_curr : row_index_curr - 1;
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;
        if (row_index < 0) {
            const { frozen } = ctx.sheets[idx];
            if (frozen) {
                if (frozen.type === 'rangeBoth' || frozen.type === 'both') {
                    frozen.type = 'rangeColumn';
                } else if (frozen.type === 'row' || frozen.type === 'rangeRow') {
                    delete ctx.sheets[idx].frozen;
                }
            }
        } else if (!ctx.sheets[idx].frozen) {
            ctx.sheets[idx].frozen = {
                type: 'rangeRow',
                range: { column_focus: 0, row_focus: row_index },
            };
        } else {
            const frozen = ctx.sheets[idx].frozen!;
            if (!frozen.range) {
                frozen.range = { column_focus: 0, row_focus: row_index };
            } else {
                frozen.range.row_focus = row_index;
            }
            if (frozen?.type === 'rangeColumn' || frozen?.type === 'column') {
                frozen.type = 'rangeBoth';
            }
        }
        const freezeHandle = container.querySelector('.sheet-rows-freeze-handle') as HTMLDivElement;
        if (freezeHandle) {
            freezeHandle.style.top = `${getFrozenHandleTop(ctx)}px`;
        }
    }

    // Selection fill/extend
    if (ctx.cellSelectExtending) {
        onDropCellSelectEnd(ctx, e, container);
    }
}
