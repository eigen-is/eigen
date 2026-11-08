// Canvas filter-button geometry. Each filterOptions item carries the one rect the canvas paints
// the button in and the mousedown hit test reads: 20×15, its right edge on the column's right edge
// (visibledatacolumn[c]), clamped to the column's own start, at the top of the filter header row,
// in sheet coordinates (scroll-independent, freeze-corrected by the caller).

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { createFilterOptions, getFilterButtonAtPosition } from '../../../state/modules/filter';
import { contextFactory } from '../factories/context';

type Range = { row: [number, number]; column: [number, number] };

// Builds the options for a filter range on the given sheet, the first and current one by default.
function buildOptions(ctx: Context, range?: Range, sheetIndex = 0) {
    ctx.sheets[sheetIndex].filterRange = range;
    createFilterOptions(ctx);
}

function ctxWithFilter(range?: Range, sheetIndex = 0): Context {
    const ctx = contextFactory() as Context;
    buildOptions(ctx, range, sheetIndex);
    return ctx;
}

// factory geometry: visibledatacolumn [74,148,222,296,370], visibledatarow [20,40,...]
const RANGE: Range = { row: [1, 3], column: [1, 2] };
const BUTTON_WIDTH = 20;
const BUTTON_HEIGHT = 15;
const COL1_LEFT = 148 - BUTTON_WIDTH;
const HEADER_TOP = 20;

describe('createFilterOptions button rects', () => {
    test('a column wider than the button keeps the 20×15 rect on its right edge', () => {
        const ctx = ctxWithFilter(RANGE);
        expect(ctx.filterOptions?.items).toEqual([
            { col: 1, left: 128, top: 20, width: 20, height: 15 },
            { col: 2, left: 202, top: 20, width: 20, height: 15 },
        ]);
    });

    test('two 10px columns side by side each keep their button inside their own column', () => {
        const ctx = contextFactory() as Context;
        // Columns 1 and 2 at the 10px resize floor, half the button's width.
        ctx.visibledatacolumn = [74, 84, 94, 296, 370];
        buildOptions(ctx, RANGE);
        expect(ctx.filterOptions?.items).toEqual([
            { col: 1, left: 74, top: 20, width: 10, height: 15 },
            { col: 2, left: 84, top: 20, width: 10, height: 15 },
        ]);
        expect(getFilterButtonAtPosition(ctx, 73, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 74, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 83, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 84, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 93, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 94, 22)).toBeUndefined();
    });

    test('a first column narrower than the button starts its button at the sheet edge', () => {
        const ctx = contextFactory() as Context;
        ctx.visibledatacolumn = [10, 84, 158, 232, 306];
        buildOptions(ctx, { row: [1, 3], column: [0, 1] });
        expect(ctx.filterOptions?.items[0]).toEqual({ col: 0, left: 0, top: 20, width: 10, height: 15 });
    });
});

describe('getFilterButtonAtPosition', () => {
    test('hit inside a button rect resolves the column', () => {
        const ctx = ctxWithFilter(RANGE);
        expect(getFilterButtonAtPosition(ctx, 130, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 147, 34)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 210, 27)?.col).toBe(2);
    });

    test('the 20×15 rect is right-aligned to the column edge: inclusive left/top, exclusive right/bottom', () => {
        const ctx = ctxWithFilter(RANGE);
        // Corners just inside
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT + BUTTON_WIDTH - 1, HEADER_TOP)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP + BUTTON_HEIGHT - 1)?.col).toBe(1);
        // One pixel outside each edge
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT - 1, HEADER_TOP)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT + BUTTON_WIDTH, HEADER_TOP)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP - 1)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP + BUTTON_HEIGHT)).toBeUndefined();
    });

    test('misses outside the rect: left of, right of, above and below', () => {
        const ctx = ctxWithFilter(RANGE);
        expect(getFilterButtonAtPosition(ctx, 127, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 148, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 19)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 35)).toBeUndefined();
    });

    test('header row 0 puts buttons at top 0', () => {
        const ctx = ctxWithFilter({ row: [0, 3], column: [0, 1] });
        expect(getFilterButtonAtPosition(ctx, 74 - BUTTON_WIDTH, 0)?.col).toBe(0);
        expect(getFilterButtonAtPosition(ctx, 148 - BUTTON_WIDTH, 0)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 74 - BUTTON_WIDTH, BUTTON_HEIGHT)).toBeUndefined();
    });

    test('resized columns shift the rects with visibledatacolumn', () => {
        const ctx = contextFactory() as Context;
        ctx.visibledatacolumn = [74, 100, 174, 296, 370];
        buildOptions(ctx, RANGE);
        expect(getFilterButtonAtPosition(ctx, 100 - BUTTON_WIDTH, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 99, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 100 - BUTTON_WIDTH - 1, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 100, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 174 - BUTTON_WIDTH, 22)?.col).toBe(2);
    });

    test('a column narrower than the button keeps the click off its neighbor', () => {
        const ctx = contextFactory() as Context;
        // Column 2 is 10px wide, the resize floor, so its button shrinks to the column
        // instead of reaching over column 1's.
        ctx.visibledatacolumn = [74, 148, 158, 296, 370];
        buildOptions(ctx, RANGE);
        expect(getFilterButtonAtPosition(ctx, 145, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 148, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 157, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 158, 22)).toBeUndefined();
    });

    test('no filter range never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(undefined), 130, 22)).toBeUndefined();
    });

    test('a range belonging to a non-current sheet never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(RANGE, 1), 130, 22)).toBeUndefined();
    });
});

describe('createFilterOptions range clamp', () => {
    // Imported xlsx autofilter ranges may extend past the materialized grid
    // (the stored range is kept verbatim for export fidelity). filterOptions is
    // what every consumer iterates — menu value/color scans, sort, condition
    // apply — so its rows must never exceed the data matrix, or the menu loops
    // read flowdata[r] of a missing row and crash on undefined[col].
    test('endRow beyond the data matrix clamps to the last data row', () => {
        const ctx = contextFactory() as Context;
        buildOptions(ctx, { row: [1, 5000], column: [1, 2] });
        expect(ctx.filterOptions?.endRow).toBe(3);
        expect(ctx.filterOptions?.startRow).toBe(1);
    });

    test('endCol beyond the grid clamps to the last column', () => {
        const ctx = contextFactory() as Context;
        buildOptions(ctx, { row: [1, 3], column: [1, 5000] });
        expect(ctx.filterOptions?.endCol).toBe(4);
        expect(ctx.filterOptions?.items.at(-1)?.col).toBe(4);
    });

    test('a range entirely past the grid yields no filterOptions', () => {
        const ctx = contextFactory() as Context;
        buildOptions(ctx, { row: [5000, 6000], column: [1, 2] });
        expect(ctx.filterOptions).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 22)).toBeUndefined();
    });
});

describe('createFilterOptions hidden columns', () => {
    // A hidden column has zero width, so it gets no button to paint or to click.
    function ctxWithHiddenColumn2(): Context {
        const ctx = contextFactory() as Context;
        ctx.sheets[0].config = { colhidden: { 2: 0 } };
        // column 2 hidden: its right edge is the same as column 1's
        ctx.visibledatacolumn = [74, 148, 148, 222, 296];
        return ctx;
    }

    test('a hidden column between two visible ones gets no button', () => {
        const ctx = ctxWithHiddenColumn2();
        buildOptions(ctx, { row: [1, 3], column: [1, 3] });
        expect(ctx.filterOptions?.items.map((item) => item.col)).toEqual([1, 3]);
    });

    test('the shared edge opens the visible column, not the hidden one', () => {
        const ctx = ctxWithHiddenColumn2();
        buildOptions(ctx, { row: [1, 3], column: [1, 3] });
        expect(getFilterButtonAtPosition(ctx, 148 - BUTTON_WIDTH, HEADER_TOP)?.col).toBe(1);
    });
});

describe('createFilterOptions without edit rights', () => {
    test('clears the buttons it would otherwise have drawn', () => {
        const ctx = ctxWithFilter(RANGE);
        ctx.allowEdit = false;
        buildOptions(ctx, RANGE);
        expect(ctx.filterOptions).toBeUndefined();
    });
});
