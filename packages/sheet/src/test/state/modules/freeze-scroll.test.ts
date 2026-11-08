// A selection drag over a sheet frozen at C3 and scrolled: the view goes back to the start only when the drag's far end
// has gone behind the frozen band. A far end in view, however close to the band, leaves the scroll alone.

import { describe, expect, test } from 'bun:test';
import type { Selection } from '../../../state';
import { initFreeze, scrollToFrozenRowCol } from '../../../state/modules/freeze';
import { workbookContextFactory } from '../factories/context';

const COLUMNS = 26;
const ROWS = 100;

function dragTo(selections: Selection[], scrollLeft: number, scrollTop: number) {
    const ctx = workbookContextFactory({
        currentSheetId: 'one',
        sheets: [
            {
                id: 'one',
                name: 'One',
                order: 0,
                frozen: { type: 'rangeBoth', range: { row_focus: 2, column_focus: 2 } },
            },
        ],
        visibledatacolumn: Array.from({ length: COLUMNS }, (_, c) => (c + 1) * 100),
        visibledatarow: Array.from({ length: ROWS }, (_, r) => (r + 1) * 20),
        selections,
        scrollLeft,
        scrollTop,
    });
    const cache = ctx.getRefs().globalCache;
    initFreeze(ctx, cache, 'one');
    scrollToFrozenRowCol(ctx, cache.freezen?.one);
    return ctx.scrollRequest;
}

// A press on `from` dragged to `to`, as column and row indexes.
function range([fromRow, fromColumn]: number[], [toRow, toColumn]: number[]): Selection {
    return {
        row: [Math.min(fromRow, toRow), Math.max(fromRow, toRow)],
        column: [Math.min(fromColumn, toColumn), Math.max(fromColumn, toColumn)],
        row_focus: fromRow,
        column_focus: fromColumn,
    };
}

describe('scrollToFrozenRowCol', () => {
    test('a far column just past the frozen edge is in view, so the scroll stays', () => {
        // At scrollLeft 300 the main pane starts at x 600, and column G spans 600 to 700.
        expect(dragTo([range([20, 6], [25, 6])], 300, 200)).toBeUndefined();
    });

    test('a far row just below the frozen edge is in view, so the scroll stays', () => {
        // At scrollTop 215 the main pane starts at y 275, and row 14 spans 260 to 280.
        expect(dragTo([range([20, 8], [13, 8])], 300, 215)).toBeUndefined();
    });

    test('a far column behind the frozen band scrolls back to the start', () => {
        expect(dragTo([range([20, 6], [20, 4])], 300, 0)).toEqual({ left: 0 });
    });

    test('a far row behind the frozen band scrolls back to the start', () => {
        expect(dragTo([range([20, 6], [5, 6])], 0, 200)).toEqual({ top: 0 });
    });

    test('a far cell inside the frozen band scrolls both axes back', () => {
        expect(dragTo([range([20, 6], [1, 1])], 300, 200)).toEqual({ left: 0, top: 0 });
    });

    test('the range being dragged decides, not an earlier one of several', () => {
        expect(dragTo([range([20, 4], [20, 4]), range([20, 6], [25, 6])], 300, 0)).toBeUndefined();
    });
});
