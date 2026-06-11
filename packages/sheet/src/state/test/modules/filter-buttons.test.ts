// Canvas filter-button geometry. The per-column autofilter buttons are drawn on
// the canvas and hit-tested in the mousedown path; both sides consume the same
// rects pinned here: a 20×15 button whose right edge sits on the column's right
// edge (visibledatacolumn[c]) at the top of the filter header row, in sheet
// coordinates (scroll-independent, freeze-corrected by the caller).

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../context';
import {
    createFilterOptions,
    FILTER_BUTTON_HEIGHT,
    FILTER_BUTTON_WIDTH,
    getFilterButtonAtPosition,
    getFilterButtonRects,
} from '../../modules/filter';
import { contextFactory } from '../factories/context';

function ctxWithFilter(range?: { row: number[]; column: number[] }, sheetId?: string): Context {
    const ctx = contextFactory() as Context;
    createFilterOptions(ctx, range, sheetId);
    return ctx;
}

const RANGE = { row: [1, 3], column: [1, 2] };

describe('getFilterButtonRects', () => {
    test('one 20×15 rect per filter column, right-aligned to the column edge on the header row', () => {
        // factory geometry: visibledatacolumn [74,148,222,296,370], visibledatarow [20,40,...]
        const rects = getFilterButtonRects(ctxWithFilter(RANGE));
        expect(rects).toEqual([
            {
                col: 1,
                left: 148 - FILTER_BUTTON_WIDTH,
                top: 20,
                width: FILTER_BUTTON_WIDTH,
                height: FILTER_BUTTON_HEIGHT,
            },
            {
                col: 2,
                left: 222 - FILTER_BUTTON_WIDTH,
                top: 20,
                width: FILTER_BUTTON_WIDTH,
                height: FILTER_BUTTON_HEIGHT,
            },
        ]);
    });

    test('header row 0 puts buttons at top 0', () => {
        const rects = getFilterButtonRects(ctxWithFilter({ row: [0, 3], column: [0, 1] }));
        expect(rects.map((r) => r.top)).toEqual([0, 0]);
        expect(rects.map((r) => r.left)).toEqual([74 - FILTER_BUTTON_WIDTH, 148 - FILTER_BUTTON_WIDTH]);
    });

    test('resized and hidden columns shift the rects with visibledatacolumn', () => {
        const ctx = contextFactory() as Context;
        // column 1 resized narrower, column 2 hidden (zero width: same edge as column 1)
        ctx.visibledatacolumn = [74, 100, 100, 296, 370];
        createFilterOptions(ctx, { row: [1, 3], column: [1, 2] }, undefined);
        const rects = getFilterButtonRects(ctx);
        expect(rects.map((r) => r.left)).toEqual([100 - FILTER_BUTTON_WIDTH, 100 - FILTER_BUTTON_WIDTH]);
    });

    test('no filter range yields no rects', () => {
        expect(getFilterButtonRects(ctxWithFilter(undefined))).toEqual([]);
    });

    test('a range belonging to a non-current sheet yields no rects', () => {
        expect(getFilterButtonRects(ctxWithFilter(RANGE, 'id_2'))).toEqual([]);
    });
});

describe('getFilterButtonAtPosition', () => {
    test('hit inside a button rect resolves the column', () => {
        const ctx = ctxWithFilter(RANGE);
        expect(getFilterButtonAtPosition(ctx, 130, 22)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 147, 34)?.col).toBe(1);
        expect(getFilterButtonAtPosition(ctx, 210, 27)?.col).toBe(2);
    });

    test('misses outside the rect: left of, right of, above and below', () => {
        const ctx = ctxWithFilter(RANGE);
        expect(getFilterButtonAtPosition(ctx, 127, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 148, 22)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 19)).toBeUndefined();
        expect(getFilterButtonAtPosition(ctx, 130, 35)).toBeUndefined();
    });

    test('no filter range never hits', () => {
        expect(getFilterButtonAtPosition(ctxWithFilter(undefined), 130, 22)).toBeUndefined();
    });
});
