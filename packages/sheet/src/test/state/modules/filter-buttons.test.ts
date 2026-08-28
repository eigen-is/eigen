// Canvas filter-button geometry. The per-column autofilter buttons are drawn on
// the canvas and hit-tested in the mousedown path; both sides consume the same
// filterOptions.items geometry pinned here through the hit-test: a 20×15 button
// whose right edge sits on the column's right edge (visibledatacolumn[c]) at the
// top of the filter header row, in sheet coordinates (scroll-independent,
// freeze-corrected by the caller).

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import {
    createFilterOptions,
    FILTER_BUTTON_HEIGHT,
    FILTER_BUTTON_WIDTH,
    getFilterButtonAtPosition,
} from '../../../state/modules/filter';
import { contextFactory } from '../factories/context';

function ctxWithFilter(range?: { row: number[]; column: number[] }, sheetId?: string): Context {
    const ctx = contextFactory() as Context;
    createFilterOptions(ctx, range, sheetId);
    return ctx;
}

// factory geometry: visibledatacolumn [74,148,222,296,370], visibledatarow [20,40,...]
const RANGE = { row: [1, 3], column: [1, 2] };
const COL1_LEFT = 148 - FILTER_BUTTON_WIDTH;
const HEADER_TOP = 20;

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
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT + FILTER_BUTTON_WIDTH - 1, HEADER_TOP)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP + FILTER_BUTTON_HEIGHT - 1)?.col).toBe(1);
        // One pixel outside each edge
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT - 1, HEADER_TOP)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT + FILTER_BUTTON_WIDTH, HEADER_TOP)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP - 1)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, COL1_LEFT, HEADER_TOP + FILTER_BUTTON_HEIGHT)).toBeUndefined();
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
        expect(getFilterButtonAtPosition(ctx, 74 - FILTER_BUTTON_WIDTH, 0)?.col).toBe(0);
        expect(getFilterButtonAtPosition(ctx, 148 - FILTER_BUTTON_WIDTH, 0)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 74 - FILTER_BUTTON_WIDTH, FILTER_BUTTON_HEIGHT)).toBeUndefined();
    });

    test('resized columns shift the rects with visibledatacolumn', () => {
        const ctx = contextFactory() as Context;
        // Column 2 is zero-width here (not colhidden, so it keeps its button): its rect
        // coincides with column 1's, and the click goes to the button actually painted on
        // top — the later one — the way the draw loop leaves it.
        ctx.visibledatacolumn = [74, 100, 100, 296, 370];
        createFilterOptions(ctx, { row: [1, 3], column: [1, 2] }, undefined);
        expect(getFilterButtonAtPosition(ctx, 100 - FILTER_BUTTON_WIDTH, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 99, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 100 - FILTER_BUTTON_WIDTH - 1, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 100, 22)).toBeUndefined();
    });

    test('a column narrower than the button gives the click to the button drawn on top', () => {
        const ctx = contextFactory() as Context;
        // Column 2 is 10px wide — the resize floor — while the button is 20, so the two
        // rects overlap. The user sees column 2's button there.
        ctx.visibledatacolumn = [74, 148, 158, 296, 370];
        createFilterOptions(ctx, { row: [1, 3], column: [1, 2] }, undefined);
        expect(getFilterButtonAtPosition(ctx, 145, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 157, 22)?.col).toBe(2);
        expect(getFilterButtonAtPosition(ctx, 137, 22)?.col).toBe(1);
    });

    test('no filter range never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(undefined), 130, 22)).toBeUndefined();
    });

    test('a range belonging to a non-current sheet never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(RANGE, 'id_2'), 130, 22)).toBeUndefined();
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
        createFilterOptions(ctx, { row: [1, 5000], column: [1, 2] }, undefined);
        expect(ctx.filterOptions?.endRow).toBe(3);
        expect(ctx.filterOptions?.startRow).toBe(1);
    });

    test('endCol beyond the grid clamps to the last column', () => {
        const ctx = contextFactory() as Context;
        createFilterOptions(ctx, { row: [1, 3], column: [1, 5000] }, undefined);
        expect(ctx.filterOptions?.endCol).toBe(4);
        expect(ctx.filterOptions?.items.at(-1)?.col).toBe(4);
    });

    test('a range entirely past the grid yields no filterOptions', () => {
        const ctx = contextFactory() as Context;
        createFilterOptions(ctx, { row: [5000, 6000], column: [1, 2] }, undefined);
        expect(ctx.filterOptions).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 22)).toBeUndefined();
    });
});

describe('createFilterOptions hidden columns', () => {
    // A hidden column has zero width, so its button rect coincides exactly with
    // the previous visible column's. Emitting a button for it made the draw loop
    // (paints the last item) and the hit-test (returns the first item) disagree,
    // so state, hover and the click target belonged to different columns.
    function ctxWithHiddenColumn2(): Context {
        const ctx = contextFactory() as Context;
        ctx.config.colhidden = { 2: 0 };
        // column 2 hidden: its right edge is the same as column 1's
        ctx.visibledatacolumn = [74, 148, 148, 222, 296];
        return ctx;
    }

    test('a hidden column between two visible ones gets no button', () => {
        const ctx = ctxWithHiddenColumn2();
        createFilterOptions(ctx, { row: [1, 3], column: [1, 3] }, undefined);
        expect(ctx.filterOptions?.items.map((item) => item.col)).toEqual([1, 3]);
    });

    test('the button on the shared edge belongs to the column the hit-test returns', () => {
        const ctx = ctxWithHiddenColumn2();
        createFilterOptions(ctx, { row: [1, 3], column: [1, 3] }, undefined);
        const items = ctx.filterOptions?.items ?? [];
        const onSharedEdge = items.filter((item) => item.left === 148 - FILTER_BUTTON_WIDTH);
        expect(onSharedEdge).toHaveLength(1);
        expect(getFilterButtonAtPosition(ctx, 148 - FILTER_BUTTON_WIDTH, HEADER_TOP)).toBe(onSharedEdge[0]);
    });
});
