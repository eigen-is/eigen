// Which painted cell glyph sits under a sheet-space point. The selection box
// carries two DOM drag hit targets (the move band, the fill handle) that sit
// over the canvas, and a glyph in the same corner used to lose to them: a press
// on the list chevron at the fill corner started a fill drag instead of opening
// the list. cellGlyphAt is the one predicate both the mousedown and the hover
// path consult before the handles get their say.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { cellGlyphAt, cellIndicatorRect } from '../../../state/modules/cell-glyph';
import { cellTextBox, dropdownChevronRect } from '../../../state/modules/data-verification';
import type { DataVerificationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';

const LIST_RULE: DataVerificationRule = { type: 'dropdown', type2: '', value1: 'Red,Green,Blue', value2: '' };
const TICK_BOX: DataVerificationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };
const NUMBER_RULE: DataVerificationRule = { type: 'number', type2: 'moreThanThe', value1: '3', value2: '' };

// A1 spans x 0..74, y 0..20 in the factory's grid; its text box is 72×18.
const A1_BOX = cellTextBox(0, 0, 74, 20);

describe('cellIndicatorRect', () => {
    test('is the 11px square the corner triangle is drawn in, anchored on the cell corner', () => {
        expect(cellIndicatorRect('left', 0, 0, 74)).toEqual({ x: -1, y: 0, size: 11 });
        expect(cellIndicatorRect('right', 0, 0, 74)).toEqual({ x: 62, y: 0, size: 11 });
    });
});

describe('cellGlyphAt', () => {
    test('the list chevron, on the same rect the painter uses', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].dataVerification = { '0_0': LIST_RULE };
        const glyph = dropdownChevronRect(A1_BOX)!;
        expect(cellGlyphAt(ctx, glyph.x + glyph.size - 1, glyph.y + glyph.size - 1)).toBe('dropdown');
        // Left of the finger-sized hit box: plain cell.
        expect(cellGlyphAt(ctx, 30, 10)).toBeUndefined();
    });

    test('the tick box', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } };
        ctx.sheets[0].dataVerification = { '0_0': TICK_BOX };
        expect(cellGlyphAt(ctx, 5, 10)).toBe('checkbox');
        expect(cellGlyphAt(ctx, 40, 10)).toBeUndefined();
    });

    test('the comment triangle in the top-right corner', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: 'hi', m: 'hi', commentCardIds: ['card'] };
        expect(cellGlyphAt(ctx, 72, 1)).toBe('comment');
        expect(cellGlyphAt(ctx, 72, 15)).toBeUndefined();
        // The same corner of a cell without a comment is nothing.
        expect(cellGlyphAt(ctx, 146, 1)).toBeUndefined();
    });

    test('the invalid-value triangle in the top-left corner, only while the value fails its rule', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: 1, m: '1' };
        ctx.sheets[0].dataVerification = { '0_0': NUMBER_RULE };
        expect(cellGlyphAt(ctx, 1, 5)).toBe('invalid');

        ctx.sheets[0].data![0][0] = { v: 5, m: '5' };
        expect(cellGlyphAt(ctx, 1, 5)).toBeUndefined();
    });

    test('an empty validated cell paints no invalid mark, so it answers none', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].dataVerification = { '0_0': NUMBER_RULE };
        expect(cellGlyphAt(ctx, 1, 5)).toBeUndefined();
    });

    test('the forced-string triangle in the top-left corner, which the painter also draws there', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        // qp === 1 marks a number stored as text; the painter draws a green corner triangle. A
        // press on it must belong to the cell, not fall through to the drag handle in that corner.
        ctx.sheets[0].data![0][0] = { v: '00123', m: '00123', qp: 1 };
        expect(cellGlyphAt(ctx, 1, 5)).toBe('forced-string');
        // A plain numeric cell in the same corner has no triangle.
        ctx.sheets[0].data![0][0] = { v: 123, m: '123' };
        expect(cellGlyphAt(ctx, 1, 5)).toBeUndefined();
    });
});
