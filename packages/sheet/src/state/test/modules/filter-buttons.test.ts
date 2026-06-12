// Canvas filter-button geometry. The per-column autofilter buttons are drawn on
// the canvas and hit-tested in the mousedown path; both sides consume the same
// filterOptions.items geometry pinned here through the hit-test: a 20×15 button
// whose right edge sits on the column's right edge (visibledatacolumn[c]) at the
// top of the filter header row, in sheet coordinates (scroll-independent,
// freeze-corrected by the caller).

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../context';
import {
    createFilterOptions,
    FILTER_BUTTON_HEIGHT,
    FILTER_BUTTON_WIDTH,
    getFilterButtonAtPosition,
} from '../../modules/filter';
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

    test('resized and hidden columns shift the rects with visibledatacolumn', () => {
        const ctx = contextFactory() as Context;
        // column 1 resized narrower, column 2 hidden (zero width: same edge as
        // column 1, so the rects coincide and the earlier column wins the hit)
        ctx.visibledatacolumn = [74, 100, 100, 296, 370];
        createFilterOptions(ctx, { row: [1, 3], column: [1, 2] }, undefined);
        expect(getFilterButtonAtPosition(ctx, 100 - FILTER_BUTTON_WIDTH, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 99, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 100 - FILTER_BUTTON_WIDTH - 1, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 100, 22)).toBeUndefined();
    });

    test('no filter range never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(undefined), 130, 22)).toBeUndefined();
    });

    test('a range belonging to a non-current sheet never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(RANGE, 'id_2'), 130, 22)).toBeUndefined();
    });
});
