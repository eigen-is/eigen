// The pointer's move and release over the grid while a button is held. handleOverlayMouseMove extends the
// selection, moves the column or row resize line, the freeze line, a cell or formula-range drag and the fill
// handle, and updates the hover on painted glyphs. handleOverlayMouseUp ends each drag, such as writing the new
// frozen pane. The sheet overlay calls both from its document-level mouse listeners.

import { freezesColumns, freezesRows, SHEET_COLUMN_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH } from '@workspace/lib/sheets';
import { cloneDeep, isNil } from 'es-toolkit/compat';
import type { Context } from '../context';
import { cancelPaintModel, onCellsMove, onCellsMoveEnd, onFormulaRangeDragEnd, rangeDrag } from '../modules';
import { mergeMoveMain } from '../modules/cell';
import { cellGlyphAt } from '../modules/cell-glyph';
import { onDropCellSelect, onDropCellSelectEnd } from '../modules/drop-cell';
import { getFilterButtonAtPosition } from '../modules/filter';
import { handleFormulaInput } from '../modules/formula-editor';
import { rangeDragColumn, rangeDragRow } from '../modules/formula-range';
import { freezeOf, getFrozenHandleLeft, getFrozenHandleTop, scrollToFrozenRowCol } from '../modules/freeze';
import { colLocation, rowLocation, SCROLLBAR_MARGIN, sheetPoint } from '../modules/location';
import { pasteHandlerOfPaintModel } from '../modules/selection';
import type { GlobalCache } from '../types';
import { getSheetIndex } from '../utils';

// A resize or freeze line stops this far before the cell area's right edge.
const LINE_RIGHT_MARGIN = 54;

export function handleOverlayMouseMove(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    onCellsMove(ctx, globalCache, e, cellArea, container);

    if (!ctx.selectionActive && !ctx.scrolling) {
        updateCanvasHover(ctx, e, cellArea);
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
        mouseRender(ctx, e, cellInput, cellArea, container, fxInput);
    }
}

export function handleOverlayMouseUp(
    ctx: Context,
    globalCache: GlobalCache,
    e: MouseEvent,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    cellInput: HTMLDivElement | null,
    fxInput: HTMLDivElement | null,
) {
    const { x, y, viewX, viewY, width, height } = sheetPoint(ctx, e, cellArea);
    onFormulaRangeDragEnd(ctx);
    onCellsMoveEnd(ctx, globalCache, e, cellArea, container);
    if (
        ctx.formulaCache.rangestart ||
        ctx.formulaCache.rangedrag_column_start ||
        ctx.formulaCache.rangedrag_row_start
    ) {
        if (document.activeElement?.id === 'sheet-functionbox-cell') {
            if (fxInput) handleFormulaInput(ctx, cellInput, fxInput, 0, undefined, false);
        } else if (cellInput) {
            handleFormulaInput(ctx, fxInput, cellInput, 0, undefined, false);
        }
    }

    if (ctx.selectionActive && ctx.painterSource) {
        pasteHandlerOfPaintModel(ctx, ctx.painterSource);
        cancelPaintModel(ctx);
    }

    ctx.selectionActive = false;
    ctx.scrolling = false;
    ctx.rowsSelected = false;
    ctx.colsSelected = false;

    if (ctx.rowsResizing) {
        ctx.rowsResizing = false;

        let delta = e.clientY - ctx.rowsResizeStart[0];

        // Don't let the row boundary be dragged past the bottom of the view.
        if (viewY > height) delta -= viewY - height;

        // A press without movement is a click on the boundary, not a resize, so it writes nothing and takes no undo
        // step. The handler goes on rather than returning, because the end of a freeze drag below shares it.
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (delta !== 0 && idx != null) {
            const row = ctx.rowsResizeStart[1];
            const rowlen = ctx.sheets[idx].config?.rowlen;
            const size = Math.max((rowlen?.[row] || ctx.defaultrowlen) + delta, 10);

            const cfg = (ctx.sheets[idx].config ??= {});
            cfg.rowlen ??= {};
            cfg.customHeight ??= {};
            cfg.customHeight[row] = 1;

            // Dragging one boundary resizes every selected row, not just the one grabbed.
            const rowSelects = ctx.selections?.filter((select) => select.row_select) ?? [];
            if (rowSelects.some((s) => row >= s.row[0] && row <= s.row[1])) {
                for (const select of rowSelects) {
                    for (let r = select.row[0]; r <= select.row[1]; r += 1) {
                        cfg.rowlen[r] = Math.ceil(size);
                    }
                }
            } else {
                cfg.rowlen[row] = Math.ceil(size);
            }
        }
    }

    if (ctx.colsResizing) {
        ctx.colsResizing = false;

        let delta = e.clientX - ctx.colsResizeStart[0];

        // Don't let the column boundary be dragged past the right edge of the view.
        const maxX = width - LINE_RIGHT_MARGIN;
        if (viewX > maxX) delta -= viewX - maxX;

        // A press without movement writes nothing, as on the row axis.
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (delta !== 0 && idx != null) {
            const columnlen = ctx.sheets[idx].config?.columnlen;
            const size = Math.max((columnlen?.[ctx.colsResizeStart[1]] || ctx.defaultcollen) + delta, 10);

            const cfg = (ctx.sheets[idx].config ??= {});
            cfg.columnlen ??= {};
            cfg.customWidth ??= {};
            cfg.customWidth[ctx.colsResizeStart[1]] = 1;

            // Dragging one boundary resizes every selected column, not just the one grabbed.
            const changeColumnIndex = ctx.colsResizeStart[1];
            const columnSelects = ctx.selections?.filter((select) => select.column_select) ?? [];
            if (columnSelects.some((s) => changeColumnIndex >= s.column[0] && changeColumnIndex <= s.column[1])) {
                for (const select of columnSelects) {
                    for (let c = select.column[0]; c <= select.column[1]; c += 1) {
                        cfg.columnlen[c] = Math.ceil(size);
                    }
                }
            } else {
                cfg.columnlen[changeColumnIndex] = Math.ceil(size);
            }
        }
    }

    // A freeze line dropped on the grid freezes up to it, and dropped on the header edge stops freezing that axis.
    if (ctx.colsFreezeDragging) {
        ctx.colsFreezeDragging = false;

        const [col_pre, col_curr, col_index_curr] = colLocation(x, ctx.visibledatacolumn);
        const col_index = x > (col_curr + col_pre) / 2 ? col_index_curr : col_index_curr - 1;
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;
        const sheet = ctx.sheets[idx];
        const { frozen } = sheet;
        if (col_index < 0) {
            if (frozen && freezesColumns(frozen)) {
                if (freezesRows(frozen)) frozen.type = 'rangeRow';
                else delete sheet.frozen;
            }
        } else if (!frozen) {
            sheet.frozen = {
                type: 'rangeColumn',
                range: { column_focus: col_index, row_focus: 0 },
            };
        } else {
            if (!frozen.range) {
                frozen.range = { column_focus: col_index, row_focus: 0 };
            } else {
                frozen.range.column_focus = col_index;
            }
            if (freezesRows(frozen) && !freezesColumns(frozen)) frozen.type = 'rangeBoth';
        }
        const freezeHandle = container.querySelector('.sheet-cols-freeze-handle');
        if (freezeHandle instanceof HTMLElement) {
            freezeHandle.style.left = `${getFrozenHandleLeft(ctx)}px`;
        }
    }

    if (ctx.rowsFreezeDragging) {
        ctx.rowsFreezeDragging = false;

        const [row_pre, row_curr, row_index_curr] = rowLocation(y, ctx.visibledatarow);
        const row_index = y > (row_curr + row_pre) / 2 ? row_index_curr : row_index_curr - 1;
        const idx = getSheetIndex(ctx, ctx.currentSheetId);
        if (idx == null) return;
        const sheet = ctx.sheets[idx];
        const { frozen } = sheet;
        if (row_index < 0) {
            if (frozen && freezesRows(frozen)) {
                if (freezesColumns(frozen)) frozen.type = 'rangeColumn';
                else delete sheet.frozen;
            }
        } else if (!frozen) {
            sheet.frozen = {
                type: 'rangeRow',
                range: { column_focus: 0, row_focus: row_index },
            };
        } else {
            if (!frozen.range) {
                frozen.range = { column_focus: 0, row_focus: row_index };
            } else {
                frozen.range.row_focus = row_index;
            }
            if (freezesColumns(frozen) && !freezesRows(frozen)) frozen.type = 'rangeBoth';
        }
        const freezeHandle = container.querySelector('.sheet-rows-freeze-handle');
        if (freezeHandle instanceof HTMLElement) {
            freezeHandle.style.top = `${getFrozenHandleTop(ctx)}px`;
        }
    }

    if (ctx.cellSelectExtending) {
        onDropCellSelectEnd(ctx, e, cellArea, container);
    }
}

// Records which painted affordance the pointer is over, such as a filter button or a cell glyph. It writes only on a
// change, so a mouse move that changes nothing redraws nothing. The cursor reads both, and the filter button's hover
// fill reads ctx.filterButtonHover. Over a glyph the drag handles drop their cursors, because a press there goes to
// the cell, not the handle.
function updateCanvasHover(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement) {
    const { x, y, inside } = sheetPoint(ctx, e, cellArea);
    const col = inside && ctx.filterOptions != null ? getFilterButtonAtPosition(ctx, x, y)?.col : undefined;
    const glyph = inside ? cellGlyphAt(ctx, x, y) : undefined;
    if (ctx.filterButtonHover !== col) ctx.filterButtonHover = col;
    if (ctx.cellGlyphHover !== glyph) ctx.cellGlyphHover = glyph;
}

function mouseRender(
    ctx: Context,
    e: MouseEvent,
    cellInput: HTMLDivElement,
    cellArea: HTMLDivElement,
    container: HTMLDivElement,
    fxInput?: HTMLDivElement | null,
) {
    // A drag past an edge of the grid, headers included, scrolls it by half the distance past the edge.
    if (ctx.scrolling && !ctx.colsResizing && !ctx.rowsResizing) {
        const { viewX, viewY, width, height } = sheetPoint(ctx, e, cellArea);
        const x = viewX + SHEET_ROW_HEADER_WIDTH;
        const y = viewY + SHEET_COLUMN_HEADER_HEIGHT;
        const winW = width - SCROLLBAR_MARGIN;
        if (y < 0 || y > height) cellArea.scrollTop = ctx.scrollTop + (y < 0 ? y : y - height) / 2;
        if (x < 0 || x > winW) cellArea.scrollLeft = ctx.scrollLeft + (x < 0 ? x : x - winW) / 2;
    }

    if (ctx.selectionActive) {
        renderCellSelection(ctx, e, cellArea);
    } else if (ctx.formulaCache.rangestart) {
        rangeDrag(ctx, e, cellInput, cellArea, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_row_start) {
        rangeDragRow(ctx, e, cellInput, cellArea, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_column_start) {
        rangeDragColumn(ctx, e, cellInput, cellArea, container, fxInput);
    } else if (ctx.rowsSelected || ctx.colsSelected || ctx.cellSelectMoving) {
        // Their own handlers draw a header drag and a cell move, so the drags below must not run during one.
    } else if (ctx.cellSelectExtending) {
        onDropCellSelect(ctx, e, cellArea, container);
    } else if (ctx.colsResizing) {
        renderColResize(ctx, e, cellArea, container);
    } else if (ctx.rowsResizing) {
        renderRowResize(ctx, e, cellArea, container);
    } else if (ctx.colsFreezeDragging) {
        renderColFreezeDrag(ctx, e, cellArea, container);
    } else if (ctx.rowsFreezeDragging) {
        renderRowFreezeDrag(ctx, e, cellArea, container);
    }
}

function renderCellSelection(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement) {
    const { x, y } = sheetPoint(ctx, e, cellArea);
    const [row_pre, row, row_index] = rowLocation(y, ctx.visibledatarow);
    const [col_pre, col, col_index] = colLocation(x, ctx.visibledatacolumn);

    const { selections } = ctx;
    const anchor = selections?.[selections.length - 1];
    const last = cloneDeep(anchor);

    if (
        !selections ||
        !anchor ||
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

    // A whole-row selection keeps every column as it extends, and a whole-column selection every row.
    const colMax = ctx.visibledatacolumn.length - 1;
    if (anchor.column[0] === 0 && anchor.column[1] === colMax) {
        last.column[1] = colMax;
        last.width_move = ctx.visibledatacolumn[colMax] - 1;
    }

    const rowMax = ctx.visibledatarow.length - 1;
    if (anchor.row[0] === 0 && anchor.row[1] === rowMax) {
        last.row[1] = rowMax;
        last.height_move = ctx.visibledatarow[rowMax] - 1;
    }

    selections[selections.length - 1] = last;

    scrollToFrozenRowCol(ctx);
}

// Shift-click and drag extend a selection along one axis (row or column), for the mouse handlers of the cells and
// the headers alike. Given the anchor selection's start (`pos`) and span, and the newly hit cell's near edge (`pre`),
// far edge (`end`) and index, it returns the extended start and span and the new [start, end] index pair. It also
// clamps the anchor's index `range` toward its `focus`, in place.
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

function renderColResize(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    const { viewX, width } = sheetPoint(ctx, e, cellArea);
    if (viewX < width - LINE_RIGHT_MARGIN) {
        const x = viewX + cellArea.scrollLeft;
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine instanceof HTMLElement) {
            changeSizeLine.style.left = `${x}px`;
        }
        // The header handle sits in the pane of the resized column. In the main pane it follows the scroll, and in the
        // frozen band it stays put.
        const vData = freezeOf(ctx)?.vertical?.freezenverticaldata;
        const inFreeze = vData != null && ctx.colsResizeStart[1] < vData.boundary;
        const handleX = inFreeze ? viewX : x;
        const changeSizeCol = container.querySelector('.sheet-cols-change-size');
        if (changeSizeCol instanceof HTMLElement) {
            changeSizeCol.style.left = `${handleX - 2}px`;
        }
    }
}

function renderRowResize(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    const { viewY, height } = sheetPoint(ctx, e, cellArea);
    if (viewY < height) {
        const y = viewY + cellArea.scrollTop;
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine instanceof HTMLElement) {
            changeSizeLine.style.top = `${y}px`;
        }
        // The handle sits in the pane of the resized row, as renderColResize places it on the other axis.
        const hData = freezeOf(ctx)?.horizontal?.freezenhorizontaldata;
        const inFreeze = hData != null && ctx.rowsResizeStart[1] < hData.boundary;
        const handleY = inFreeze ? viewY : y;
        const changeSizeRow = container.querySelector('.sheet-rows-change-size');
        if (changeSizeRow instanceof HTMLElement) {
            changeSizeRow.style.top = `${handleY - 2}px`;
        }
    }
}

// The drag lines and the freeze handles live on the main pane's transform, so they take its position even over a
// frozen pane.
function renderColFreezeDrag(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    const { viewX, width } = sheetPoint(ctx, e, cellArea);
    const x = viewX + cellArea.scrollLeft;
    const [col_pre, col_curr] = colLocation(x, ctx.visibledatacolumn);

    const col = x > (col_pre + col_curr) / 2 ? col_curr : col_pre;

    if (viewX < width - LINE_RIGHT_MARGIN) {
        const freezeLine = container.querySelector('.sheet-freeze-drag-line');
        if (freezeLine instanceof HTMLElement) {
            freezeLine.style.left = `${Math.max(0, col - 2)}px`;
        }
        const freezeHandle = container.querySelector('.sheet-cols-freeze-handle');
        if (freezeHandle instanceof HTMLElement) {
            freezeHandle.style.left = `${x}px`;
        }
        // The freeze drag shows the resize line too, at the pointer.
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine instanceof HTMLElement) {
            changeSizeLine.style.left = `${x}px`;
        }
    }
}

function renderRowFreezeDrag(ctx: Context, e: MouseEvent, cellArea: HTMLDivElement, container: HTMLDivElement) {
    const { viewY, height } = sheetPoint(ctx, e, cellArea);
    const y = viewY + cellArea.scrollTop;
    const [row_pre, row_curr] = rowLocation(y, ctx.visibledatarow);

    const row = y > (row_curr + row_pre) / 2 ? row_curr : row_pre;

    if (viewY < height) {
        const freezeLine = container.querySelector('.sheet-freeze-drag-line');
        if (freezeLine instanceof HTMLElement) {
            freezeLine.style.top = `${Math.max(0, row - 2)}px`;
        }
        const freezeHandle = container.querySelector('.sheet-rows-freeze-handle');
        if (freezeHandle instanceof HTMLElement) {
            freezeHandle.style.top = `${y}px`;
        }
        const changeSizeLine = container.querySelector('.sheet-change-size-line');
        if (changeSizeLine instanceof HTMLElement) {
            changeSizeLine.style.top = `${y}px`;
        }
    }
}
