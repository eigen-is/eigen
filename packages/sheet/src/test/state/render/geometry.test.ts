// Pure viewport geometry for the canvas renderer. visibledatarow/-column hold
// cumulative bottom/right edges per index; these helpers pin the inherited
// fortune-sheet conventions: rows sit one pixel above columns (the -1 shift)
// and the header range keeps an end index of positions.length when the
// viewport extends past the last entry.

import { describe, expect, test } from 'bun:test';
import {
    colEndX,
    colStartX,
    headerVisibleRange,
    mainVisibleRange,
    rowEndY,
    rowStartY,
    sheetToCanvasX,
    sheetToCanvasY,
} from '../../../state/render/geometry';

// factory geometry: 5 rows of 20px, 5 columns of 74px
const ROWS = [20, 40, 60, 80, 100];
const COLS = [74, 148, 222, 296, 370];

describe('mainVisibleRange', () => {
    test('viewport inside the data picks the touched index span', () => {
        expect(mainVisibleRange(ROWS, 0, 50, 0)).toEqual({ start: 0, end: 2 });
        expect(mainVisibleRange(ROWS, 30, 40, 0)).toEqual({ start: 1, end: 3 });
    });

    test('a scroll position exactly on an edge starts at that index', () => {
        expect(mainVisibleRange(ROWS, 20, 20, 0)).toEqual({ start: 0, end: 1 });
    });

    test('viewport past the last entry clamps end to the last index', () => {
        expect(mainVisibleRange(ROWS, 30, 200, 0)).toEqual({ start: 1, end: 4 });
        expect(mainVisibleRange(ROWS, 0, 1000, 0)).toEqual({ start: 0, end: 4 });
    });

    test('freeze-region cell offset shifts both ends, end stays clamped', () => {
        expect(mainVisibleRange(ROWS, 0, 50, 2)).toEqual({ start: 2, end: 4 });
        expect(mainVisibleRange(ROWS, 0, 1000, 2)).toEqual({ start: 2, end: 4 });
    });
});

describe('headerVisibleRange', () => {
    test('matches the main range inside the data', () => {
        expect(headerVisibleRange(COLS, 80, 100)).toEqual({ start: 1, end: 2 });
    });

    test('keeps end at positions.length past the last entry (inherited; that iteration draws nothing)', () => {
        expect(headerVisibleRange(COLS, 0, 1000)).toEqual({ start: 0, end: 5 });
    });
});

describe('cell edges', () => {
    test('column edges subtract the scroll, first column starts at -scroll', () => {
        expect(colStartX(COLS, 0, 10)).toBe(-10);
        expect(colStartX(COLS, 2, 10)).toBe(148 - 10);
        expect(colEndX(COLS, 2, 10)).toBe(222 - 10);
    });

    test('row edges carry the extra one-pixel upward shift on the start only', () => {
        expect(rowStartY(ROWS, 0, 10)).toBe(-10 - 1);
        expect(rowStartY(ROWS, 2, 10)).toBe(40 - 10 - 1);
        expect(rowEndY(ROWS, 2, 10)).toBe(60 - 10);
    });

    test('zero scroll keeps sheet coordinates (overflow-trace call sites)', () => {
        // -0, not 0: the negation of the scroll offset. Arithmetic-identical
        // for every call site (comparisons and subtraction only).
        expect(colStartX(COLS, 0, 0)).toBe(-0);
        expect(colStartX(COLS, 3, 0)).toBe(222);
        expect(colEndX(COLS, 3, 0)).toBe(296);
    });
});

describe('sheet-to-canvas mapping', () => {
    test('subtracts the scroll and adds the header offset into the -1-shifted canvas space', () => {
        // rowHeaderWidth 46 / columnHeaderHeight 20 (state/settings defaults)
        expect(sheetToCanvasX(148, 30, 46)).toBe(148 - 30 + 46 - 1);
        expect(sheetToCanvasY(20, 10, 20)).toBe(20 - 10 + 20 - 1);
        expect(sheetToCanvasX(0, 0, 46)).toBe(45);
        expect(sheetToCanvasY(0, 0, 20)).toBe(19);
    });
});
