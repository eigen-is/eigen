// A pointer's place on the sheet: sheetPoint itself, and the handlers that measured it their own way before it, each
// over the case that was wrong. The grid sits at (300, 200) on the page, away from the top-left corner and from
// fortune-sheet's fixed bar heights, and in the frozen cases column A and rows 1 and 2 stay put over a scrolled sheet.

import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Context, Freezen } from '../../../state';
import {
    handleCellAreaDoubleClick,
    handleCellAreaMouseDown,
    handleContextMenu,
} from '../../../state/events/mouse-cell';
import { handleOverlayMouseMove, handleOverlayMouseUp } from '../../../state/events/mouse-drag';
import { handleColumnHeaderMouseDown, handleRowHeaderMouseDown } from '../../../state/events/mouse-header';
import { handleColSizeHandleMouseDown, handleRowSizeHandleMouseDown } from '../../../state/events/mouse-resize';
import { createDropCellRange, onDropCellSelect, onDropCellSelectEnd } from '../../../state/modules/drop-cell';
import { rangeDrag, rangeDragColumn, rangeDragRow } from '../../../state/modules/formula-range';
import { getCellRowColumn } from '../../../state/modules/hyperlink';
import { sheetPoint } from '../../../state/modules/location';
import { onCellsMove, onCellsMoveEnd, onCellsMoveStart } from '../../../state/modules/move-cells';
import { workbookContextFactory } from '../factories/context';
import { gridElements } from '../factories/grid-dom';
import { validationsByCell } from '../factories/validations';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
(globalThis as any).DOMParser = new Window().DOMParser;

const LEFT = 300;
const TOP = 200;
const WIDTH = 700;
const HEIGHT = 500;
const COLUMN = 74;
const ROW = 20;

const FROZEN: Freezen = {
    vertical: {
        freezenverticaldata: { pos: COLUMN, boundary: 1, scroll: 0, cumulative: [], edge: 0 },
    },
    horizontal: {
        freezenhorizontaldata: { pos: 2 * ROW, boundary: 2, scroll: 0, cumulative: [], edge: 0 },
    },
};

function cellAreaAt(scrollLeft = 0, scrollTop = 0) {
    const { scrollEl } = gridElements();
    scrollEl.getBoundingClientRect = () => ({ left: LEFT, top: TOP, width: WIDTH, height: HEIGHT }) as DOMRect;
    scrollEl.scrollLeft = scrollLeft;
    scrollEl.scrollTop = scrollTop;
    return scrollEl;
}

function grid(freeze?: Freezen): Context {
    const size = 40;
    const ctx = workbookContextFactory({
        visibledatarow: Array.from({ length: size }, (_, i) => (i + 1) * ROW),
        visibledatacolumn: Array.from({ length: size }, (_, i) => (i + 1) * COLUMN),
    });
    ctx.sheets[0].data = Array.from({ length: size }, () => Array.from({ length: size }, () => null));
    if (freeze) ctx.getRefs().globalCache.freezen = { [ctx.currentSheetId]: freeze };
    return ctx;
}

const at = (viewX: number, viewY: number) =>
    ({
        clientX: LEFT + viewX,
        clientY: TOP + viewY,
        button: 0,
        preventDefault: () => {},
        stopPropagation: () => {},
    }) as MouseEvent;

const noElements = () => gridElements().container;
const noInput = () => gridElements().container;

describe('sheetPoint', () => {
    test('measures from the cell area and adds the scroll', () => {
        const point = sheetPoint(grid(), at(30, 50), cellAreaAt(148, 400));
        expect(point).toEqual({
            viewX: 30,
            viewY: 50,
            width: WIDTH,
            height: HEIGHT,
            x: 178,
            y: 450,
            inside: true,
            pane: 'main',
        });
    });

    test('a frozen column keeps its place on the sheet, and the other axis still scrolls', () => {
        const point = sheetPoint(grid(FROZEN), at(30, 50), cellAreaAt(148, 400));
        expect([point.x, point.y, point.pane]).toEqual([30, 450, 'cols']);
    });

    test('frozen rows keep their place on the sheet, and the other axis still scrolls', () => {
        const point = sheetPoint(grid(FROZEN), at(100, 30), cellAreaAt(148, 400));
        expect([point.x, point.y, point.pane]).toEqual([248, 30, 'rows']);
    });

    test('the corner of the panes stays put on both axes', () => {
        const point = sheetPoint(grid(FROZEN), at(30, 30), cellAreaAt(148, 400));
        expect([point.x, point.y, point.pane]).toEqual([30, 30, 'corner']);
    });

    test('the frozen pane ends at its far edge', () => {
        const ctx = grid(FROZEN);
        expect(sheetPoint(ctx, at(COLUMN - 1, 100), cellAreaAt(148)).pane).toBe('cols');
        expect(sheetPoint(ctx, at(COLUMN, 100), cellAreaAt(148)).pane).toBe('main');
    });

    test('a sheet frozen elsewhere reads as the sheet the pointer is on', () => {
        const ctx = grid();
        ctx.getRefs().globalCache.freezen = { other_sheet: FROZEN };
        expect(sheetPoint(ctx, at(30, 30), cellAreaAt(148, 400)).pane).toBe('main');
    });

    test('inside covers the cell area and nothing past its edges', () => {
        const ctx = grid();
        const inside = (viewX: number, viewY: number) => sheetPoint(ctx, at(viewX, viewY), cellAreaAt()).inside;
        expect(inside(0, 0)).toBe(true);
        expect(inside(WIDTH - 1, HEIGHT - 1)).toBe(true);
        expect(inside(-1, 10)).toBe(false);
        expect(inside(10, -1)).toBe(false);
        expect(inside(WIDTH, 10)).toBe(false);
        expect(inside(10, HEIGHT)).toBe(false);
    });
});

describe('the link card', () => {
    test('over a frozen column of a scrolled sheet reads the frozen cell, not the one scrolled under it', () => {
        expect(getCellRowColumn(grid(FROZEN), at(30, 50), cellAreaAt(148, 400))).toEqual({ r: 22, c: 0 });
    });
});

describe('a formula range drag', () => {
    let ctx: Context;
    const selected = () => ctx.formulaCache.func_selectedrange;
    beforeEach(() => {
        ctx = grid();
        ctx.formulaCache.func_selectedrange = {
            row: [0, 0],
            column: [0, 0],
            row_focus: 0,
            column_focus: 0,
            left: 0,
            top: 0,
            width: 73,
            height: 19,
            left_move: 0,
            top_move: 0,
            width_move: 73,
            height_move: 19,
        };
    });

    test('over a row header picks the row under the pointer, wherever the grid sits on the page', () => {
        rangeDragRow(ctx, at(-10, 2 * ROW + 5), noInput(), cellAreaAt(), noElements());
        expect(selected()?.row).toEqual([0, 2]);
    });

    test('over a row header follows the scroll', () => {
        rangeDragRow(ctx, at(-10, 5), noInput(), cellAreaAt(0, 10 * ROW), noElements());
        expect(selected()?.row).toEqual([0, 10]);
    });

    test('over a column header picks the column under the pointer, wherever the grid sits on the page', () => {
        rangeDragColumn(ctx, at(2 * COLUMN + 5, -10), noInput(), cellAreaAt(), noElements());
        expect(selected()?.column).toEqual([0, 2]);
    });

    test('over frozen rows picks the frozen row, not the one scrolled under it', () => {
        ctx.getRefs().globalCache.freezen = { [ctx.currentSheetId]: FROZEN };
        rangeDragRow(ctx, at(-10, ROW + 5), noInput(), cellAreaAt(0, 10 * ROW), noElements());
        expect(selected()?.row).toEqual([0, 1]);
    });

    test('over a frozen column picks the frozen column, not the one scrolled under it', () => {
        ctx.getRefs().globalCache.freezen = { [ctx.currentSheetId]: FROZEN };
        rangeDrag(ctx, at(5, 100), noInput(), cellAreaAt(3 * COLUMN), noElements());
        expect(selected()?.column).toEqual([0, 0]);
    });
});

describe('a cell move', () => {
    const moved = (ctx: Context, drop: MouseEvent, cellArea: HTMLDivElement) => {
        ctx.cellSelectMoving = true;
        ctx.cellSelectMoveIndex = [0, 10];
        ctx.selections = [{ row: [0, 0], column: [10, 10], row_focus: 0, column_focus: 10 }];
        onCellsMoveEnd(ctx, ctx.getRefs().globalCache, drop, cellArea, noElements());
        return ctx.selections?.[0];
    };

    test('near the bottom of a grid low on the page lands where it is dropped, not on the last row', () => {
        const dropped = moved(grid(), at(10 * COLUMN + 5, HEIGHT - 10), cellAreaAt());
        expect(dropped?.row).toEqual([24, 24]);
    });

    test('below the grid lands on the last row', () => {
        const ctx = grid();
        expect(moved(ctx, at(10 * COLUMN + 5, HEIGHT + 1), cellAreaAt())?.row).toEqual([39, 39]);
    });

    test('dropped on a frozen column of a scrolled sheet lands in that column', () => {
        const dropped = moved(grid(FROZEN), at(5, 100), cellAreaAt(3 * COLUMN));
        expect(dropped?.column).toEqual([0, 0]);
    });

    test('grabbed in a frozen column remembers the cell it grabbed there', () => {
        const ctx = grid(FROZEN);
        ctx.selections = [{ row: [0, 9], column: [0, 5], row_focus: 0, column_focus: 0 }];
        onCellsMoveStart(ctx, ctx.getRefs().globalCache, at(5, 100), cellAreaAt(3 * COLUMN), noElements());
        expect(ctx.cellSelectMoveIndex[1]).toBe(0);
    });
});

describe('a fill drag', () => {
    test('pressed in a frozen column of a scrolled sheet starts from the frozen cell', () => {
        const ctx = grid(FROZEN);
        createDropCellRange(ctx, at(5, 105), cellAreaAt(3 * COLUMN), noElements());
        expect(ctx.cellSelectExtendIndex).toEqual([5, 0]);
    });

    test('dragged onto a frozen row of a scrolled sheet reads the frozen row', () => {
        const ctx = grid(FROZEN);
        ctx.cellSelectExtendIndex = [12, 3];
        ctx.selections = [
            {
                row: [12, 12],
                column: [3, 3],
                row_focus: 12,
                column_focus: 3,
                left_move: 222,
                top_move: 240,
                width_move: 73,
                height_move: 19,
            },
        ];
        const container = noElements();
        const preview = container.ownerDocument.createElement('div');
        preview.className = 'sheet-cell-selected-extend';
        container.append(preview);
        onDropCellSelect(ctx, at(3 * COLUMN + 5, 5), cellAreaAt(0, 10 * ROW), container);
        // The preview runs up to row 1 on the frozen pane, not to row 11 scrolled under it.
        expect(preview.style.top).toBe('0px');
    });
});

describe('a freeze line drop', () => {
    const released = (ctx: Context, drop: MouseEvent, cellArea: HTMLDivElement) => {
        handleOverlayMouseUp(ctx, ctx.getRefs().globalCache, drop, cellArea, noElements(), null, null);
        return ctx.sheets[0].frozen;
    };
    const frozenTwoColumns: Freezen = {
        vertical: { freezenverticaldata: { pos: 2 * COLUMN, boundary: 2, scroll: 0, cumulative: [], edge: 0 } },
    };
    const twoColumns = { type: 'rangeColumn', range: { row_focus: 0, column_focus: 1 } } as const;

    test('inside the frozen pane of a scrolled sheet ends the pane where it was dropped', () => {
        const ctx = grid(frozenTwoColumns);
        ctx.sheets[0].frozen = { ...twoColumns };
        ctx.colsFreezeDragging = true;
        expect(released(ctx, at(COLUMN + 5, 100), cellAreaAt(10 * COLUMN))?.range?.column_focus).toBe(0);
    });

    test('at the header edge of a scrolled sheet stops freezing', () => {
        const ctx = grid(frozenTwoColumns);
        ctx.sheets[0].frozen = { ...twoColumns };
        ctx.colsFreezeDragging = true;
        expect(released(ctx, at(-20, 100), cellAreaAt(10 * COLUMN))).toBeUndefined();
    });

    test('past the pane on a scrolled sheet freezes up to the column in view there', () => {
        const ctx = grid(frozenTwoColumns);
        ctx.sheets[0].frozen = { ...twoColumns };
        ctx.colsFreezeDragging = true;
        expect(released(ctx, at(3 * COLUMN + 5, 100), cellAreaAt(10 * COLUMN))?.range?.column_focus).toBe(12);
    });
});

describe('a header press', () => {
    test('a press on a row header picks the row at the same place the cells do', () => {
        const ctx = grid();
        const cellInput = noInput();
        handleRowHeaderMouseDown(ctx, ctx.getRefs().globalCache, at(-10, ROW - 1), cellAreaAt(), cellInput, null);
        expect(ctx.selections?.[0]?.row).toEqual([0, 0]);
    });

    test('a resize grab reads the column it is on in a frozen pane of a scrolled sheet', () => {
        const ctx = grid(FROZEN);
        handleColSizeHandleMouseDown(ctx, at(COLUMN - 2, -10), noElements(), cellAreaAt(5 * COLUMN));
        expect(ctx.colsResizeStart[1]).toBe(0);
    });
});

describe('a mouse move over the grid', () => {
    test('off the cell area marks no glyph and no filter button', () => {
        const ctx = grid();
        ctx.filterButtonHover = 2;
        ctx.cellGlyphHover = 'dropdown';
        // Over the column header with a small scroll, the sheet position alone would land on the button.
        ctx.filterOptions = {
            startRow: 0,
            endRow: 5,
            startCol: 0,
            endCol: 5,
            left: 0,
            top: 0,
            width: 444,
            height: 120,
            items: [{ col: 0, left: 0, top: 0, width: 74, height: 20 }],
        };
        handleOverlayMouseMove(ctx, ctx.getRefs().globalCache, at(10, -5), noInput(), cellAreaAt(0, 10), noElements());
        expect(ctx.filterButtonHover).toBeUndefined();
        expect(ctx.cellGlyphHover).toBeUndefined();
    });
});

describe('the frozen and scrolled cases of each remaining handler', () => {
    const selectedCell = (ctx: Context) => ctx.selections?.[0];
    const scrolled = () => cellAreaAt(3 * COLUMN, 10 * ROW);

    test('a press in a frozen column selects the frozen cell and asks for no scroll', () => {
        const ctx = grid(FROZEN);
        ctx.editingCellPosition = [];
        ctx.scrollLeft = 3 * COLUMN;
        ctx.scrollTop = 10 * ROW;
        handleCellAreaMouseDown(ctx, ctx.getRefs().globalCache, at(5, 2 * ROW + 5), noInput(), scrolled());
        expect(selectedCell(ctx)?.column).toEqual([0, 0]);
        expect(selectedCell(ctx)?.row).toEqual([12, 12]);
        expect(ctx.scrollRequest).toBeUndefined();
    });

    test('a press on a cell cut off by the scroll asks to bring it back', () => {
        const ctx = grid();
        ctx.editingCellPosition = [];
        ctx.scrollLeft = COLUMN + 10;
        handleCellAreaMouseDown(ctx, ctx.getRefs().globalCache, at(5, 5), noInput(), cellAreaAt(COLUMN + 10));
        expect(ctx.scrollRequest).toEqual({ left: COLUMN });
    });

    test('a press that reaches the cell area from outside its rect selects nothing', () => {
        const ctx = grid();
        ctx.editingCellPosition = [];
        ctx.selections = [];
        handleCellAreaMouseDown(ctx, ctx.getRefs().globalCache, at(-5, 5), noInput(), cellAreaAt());
        expect(ctx.selections).toEqual([]);
    });

    test('a double click reads the frozen cell, so a frozen tick box opens no editor', () => {
        const ctx = grid(FROZEN);
        ctx.editingCellPosition = [];
        ctx.sheets[0].dataValidations = validationsByCell({
            '12_0': { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' },
        });
        ctx.selections = [{ row: [12, 12], column: [0, 0], row_focus: 12, column_focus: 0 }];
        handleCellAreaDoubleClick(ctx, at(5, 2 * ROW + 5), scrolled());
        expect(ctx.editingCellPosition).toEqual([]);
    });

    test('a right click reads the pane in each area', () => {
        const point = (viewX: number, viewY: number) => {
            const { clientX, clientY } = at(viewX, viewY);
            return { clientX, clientY };
        };
        const cell = grid(FROZEN);
        handleContextMenu(cell, point(5, 2 * ROW + 5), scrolled(), 'cell');
        expect(selectedCell(cell)?.column).toEqual([0, 0]);
        expect(selectedCell(cell)?.row).toEqual([12, 12]);

        const row = grid(FROZEN);
        handleContextMenu(row, point(-10, ROW + 5), scrolled(), 'rowHeader');
        expect(selectedCell(row)?.row).toEqual([1, 1]);

        const column = grid(FROZEN);
        handleContextMenu(column, point(5, -10), scrolled(), 'columnHeader');
        expect(selectedCell(column)?.column).toEqual([0, 0]);
    });

    test('a column header press reads the frozen column', () => {
        const ctx = grid(FROZEN);
        handleColumnHeaderMouseDown(ctx, ctx.getRefs().globalCache, at(5, -10), scrolled(), noInput(), null);
        expect(selectedCell(ctx)?.column).toEqual([0, 0]);
    });

    test('a row resize grab reads the row it is on in a frozen pane', () => {
        const ctx = grid(FROZEN);
        handleRowSizeHandleMouseDown(ctx, at(-10, ROW - 2), noElements(), scrolled());
        expect(ctx.rowsResizeStart[1]).toBe(0);
    });

    test('a column header drag while composing reads the frozen column', () => {
        const ctx = grid(FROZEN);
        ctx.formulaCache.func_selectedrange = {
            row: [0, 0],
            column: [0, 0],
            row_focus: 0,
            column_focus: 0,
            left: 0,
            top: 0,
            width: 73,
            height: 19,
            left_move: 0,
            top_move: 0,
            width_move: 73,
            height_move: 19,
        };
        rangeDragColumn(ctx, at(5, -10), noInput(), scrolled(), noElements());
        expect(ctx.formulaCache.func_selectedrange?.column).toEqual([0, 0]);
    });

    test('a fill released on a frozen row of a scrolled sheet fills up to that row', () => {
        const ctx = grid(FROZEN);
        ctx.cellSelectExtendIndex = [12, 3];
        ctx.selections = [
            {
                row: [12, 12],
                column: [3, 3],
                row_focus: 12,
                column_focus: 3,
                left: 3 * COLUMN,
                top: 12 * ROW,
                width: COLUMN - 1,
                height: ROW - 1,
                left_move: 3 * COLUMN,
                top_move: 12 * ROW,
                width_move: COLUMN - 1,
                height_move: ROW - 1,
            },
        ];
        onDropCellSelectEnd(ctx, at(3 * COLUMN + 5, 5), cellAreaAt(0, 10 * ROW), noElements());
        expect(selectedCell(ctx)?.row).toEqual([0, 12]);
    });

    test('a cell move draws its preview on the frozen column it is over', () => {
        const ctx = grid(FROZEN);
        ctx.cellSelectMoving = true;
        ctx.cellSelectMoveIndex = [0, 3];
        ctx.selections = [{ row: [0, 0], column: [3, 3], row_focus: 0, column_focus: 3 }];
        const container = noElements();
        const preview = container.ownerDocument.createElement('div');
        preview.className = 'sheet-cell-selected-move';
        container.append(preview);
        onCellsMove(ctx, ctx.getRefs().globalCache, at(5, 5), scrolled(), container);
        expect(preview.style.left).toBe('0px');
    });

    test('a frozen row drop on a scrolled sheet ends the pane where it was dropped', () => {
        const ctx = grid(FROZEN);
        ctx.sheets[0].frozen = { type: 'rangeBoth', range: { row_focus: 1, column_focus: 0 } };
        ctx.rowsFreezeDragging = true;
        handleOverlayMouseUp(
            ctx,
            ctx.getRefs().globalCache,
            at(-10, ROW + 5),
            cellAreaAt(0, 10 * ROW),
            noElements(),
            null,
            null,
        );
        expect(ctx.sheets[0].frozen?.range?.row_focus).toBe(0);
    });
});

describe('a resize', () => {
    const release = (ctx: Context, drop: MouseEvent) =>
        handleOverlayMouseUp(ctx, ctx.getRefs().globalCache, drop, cellAreaAt(), noElements(), null, null);

    test('of a row stops at the bottom of the view', () => {
        const ctx = grid();
        ctx.rowsResizing = true;
        ctx.rowsResizeStart = [TOP + HEIGHT - 10, 2];
        release(ctx, at(0, HEIGHT + 100));
        expect(ctx.sheets[0].config?.rowlen?.[2]).toBe(ctx.defaultrowlen + 10);
    });

    test('of a column stops short of the right edge of the view', () => {
        const ctx = grid();
        ctx.colsResizing = true;
        ctx.colsResizeStart = [LEFT + WIDTH - 64, 2];
        release(ctx, at(WIDTH + 100, 0));
        expect(ctx.sheets[0].config?.columnlen?.[2]).toBe(ctx.defaultcollen + 10);
    });

    test('moves its line under the pointer on the main pane, and its handle in the frozen pane', () => {
        const ctx = grid(FROZEN);
        ctx.colsResizing = true;
        ctx.scrolling = true;
        ctx.colsResizeStart = [0, 0];
        const container = noElements();
        const line = container.ownerDocument.createElement('div');
        line.className = 'sheet-change-size-line';
        const handle = container.ownerDocument.createElement('div');
        handle.className = 'sheet-cols-change-size';
        container.append(line, handle);
        handleOverlayMouseMove(ctx, ctx.getRefs().globalCache, at(50, -5), noInput(), cellAreaAt(148), container);
        expect(line.style.left).toBe('198px');
        expect(handle.style.left).toBe('48px');
    });
});

describe('a freeze line drag', () => {
    test('keeps its handle under the pointer on the main pane, even over a frozen pane', () => {
        const ctx = grid(FROZEN);
        ctx.colsFreezeDragging = true;
        ctx.scrolling = true;
        const container = noElements();
        const handle = container.ownerDocument.createElement('div');
        handle.className = 'sheet-cols-freeze-handle';
        container.append(handle);
        handleOverlayMouseMove(ctx, ctx.getRefs().globalCache, at(50, -5), noInput(), cellAreaAt(148), container);
        expect(handle.style.left).toBe('198px');
    });
});

describe('a drag past an edge', () => {
    const dragged = () => {
        const ctx = grid();
        ctx.selectionActive = true;
        ctx.scrolling = true;
        ctx.selections = [];
        return ctx;
    };

    test('scrolls the grid by half the distance past the edge', () => {
        const ctx = dragged();
        const cellArea = cellAreaAt();
        handleOverlayMouseMove(ctx, ctx.getRefs().globalCache, at(10, HEIGHT + 40), noInput(), cellArea, noElements());
        expect(cellArea.scrollTop).toBe(30);
    });

    test('above the column headers scrolls up, and over them does not', () => {
        const ctx = dragged();
        ctx.scrollTop = 200;
        const cellArea = cellAreaAt(0, 200);
        const move = (viewY: number) =>
            handleOverlayMouseMove(ctx, ctx.getRefs().globalCache, at(10, viewY), noInput(), cellArea, noElements());
        move(-10);
        expect(cellArea.scrollTop).toBe(200);
        move(-40);
        expect(cellArea.scrollTop).toBe(190);
    });
});
