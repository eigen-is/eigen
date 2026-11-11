// Which painted cell glyph sits under a sheet-space point. The selection box carries two DOM drag targets, the move
// band and the fill handle, over the canvas, and a press on a list chevron or a tick box in the same place belongs to
// the glyph. A corner mark claims nothing, as in Google Sheets: a press on it is a press on the cell or the band.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { cellGlyphAt, cellIndicatorRect } from '../../../state/modules/cell-glyph';
import { cellTextBox, dropdownChevronRect } from '../../../state/modules/data-validation';
import type { DataValidationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';
import { validationsByCell } from '../factories/validations';

const LIST_RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: 'Red,Green,Blue', value2: '' };
const TICK_BOX: DataValidationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };
const NUMBER_RULE: DataValidationRule = { type: 'number', type2: 'moreThanThe', value1: '3', value2: '' };

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
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': LIST_RULE });
        const glyph = dropdownChevronRect(A1_BOX)!;
        expect(cellGlyphAt(ctx, glyph.x + glyph.size - 1, glyph.y + glyph.size - 1)).toBe('dropdown');
        // Left of the finger-sized hit box: plain cell.
        expect(cellGlyphAt(ctx, 30, 10)).toBeUndefined();
    });

    test('the tick box', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } };
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': TICK_BOX });
        expect(cellGlyphAt(ctx, 36, 10)).toBe('checkbox');
        expect(cellGlyphAt(ctx, 5, 10)).toBeUndefined();
    });

    test('a tick box holding a value its rule does not name paints no box, so it answers none', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: 'Maybe', m: 'Maybe' };
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': TICK_BOX });
        expect(cellGlyphAt(ctx, 36, 10)).toBeUndefined();
    });

    test('a corner mark is no glyph: a comment, an invalid value and a number stored as text', () => {
        const ctx = contextFactory({ selections: [] }) as Context;
        ctx.sheets[0].data![0][0] = { v: 'hi', m: 'hi', commentCardIds: ['card'] };
        expect(cellGlyphAt(ctx, 72, 1)).toBeUndefined();

        ctx.sheets[0].data![0][0] = { v: 1, m: '1' };
        ctx.sheets[0].dataValidations = validationsByCell({ '0_0': NUMBER_RULE });
        expect(cellGlyphAt(ctx, 1, 5)).toBeUndefined();

        ctx.sheets[0].dataValidations = {};
        ctx.sheets[0].data![0][0] = { v: '00123', m: '00123', qp: 1 };
        expect(cellGlyphAt(ctx, 1, 5)).toBeUndefined();
    });
});
