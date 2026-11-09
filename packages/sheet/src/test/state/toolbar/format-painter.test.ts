// The format painter leaves the destination's value and link and lands the source's formats.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { pasteHandlerOfPaintModel } from '../../../state/modules/selection';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

function painted(source: Cell, destination: Cell) {
    const ctx = contextFactory({
        currentSheetId: 'id_1',
        selections: [{ row: [0, 0], column: [1, 1] }],
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data: [[source, destination]] }],
    }) as Context;
    pasteHandlerOfPaintModel(ctx, { sheetId: 'id_1', range: { row: [0, 0], column: [0, 0] } });
    return ctx.sheets[0].data?.[0][1];
}

const FORMATTED: Cell = { v: 1, m: '1.00', ct: { fa: '0.00', t: 'n' } };

describe('the format painter over a formula', () => {
    test('a text result stays text', () => {
        const cell = painted(FORMATTED, { f: '=IF(1,"005",5)', v: '005', m: '005', ct: { fa: 'General', t: 'g' } });
        expect(cell).toMatchObject({ v: '005', m: '005', ct: { fa: '0.00', t: 'g' } });
    });

    test('an error stays an error', () => {
        const cell = painted(FORMATTED, { f: '=1/0', v: '#DIV/0!', m: '#DIV/0!', ct: { fa: 'General', t: 'e' } });
        expect(cell).toMatchObject({ v: '#DIV/0!', m: '#DIV/0!', ct: { fa: '0.00', t: 'e' } });
    });

    test('a number shows in the painted format', () => {
        const cell = painted(FORMATTED, { f: '=1+1', v: 2, m: '2', ct: { fa: 'General', t: 'n' } });
        expect(cell).toMatchObject({ v: 2, m: '2.00', ct: { fa: '0.00', t: 'n' } });
    });
});

test('the format painter over a constant shows its number in the painted format', () => {
    expect(painted(FORMATTED, { v: 2, m: '2', ct: { fa: 'General', t: 'n' } })).toMatchObject({ v: 2, m: '2.00' });
});
