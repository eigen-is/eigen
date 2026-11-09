// The format painter leaves the destination's value and link and lands the source's formats.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { pasteHandlerOfPaintModel } from '../../../state/modules/selection';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

function painted(source: Cell | null, destination: Cell | null) {
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

describe('the format painter from a source with no number format', () => {
    const PERCENT: Cell = { v: 0.5, m: '50%', ct: { fa: '0%', t: 'n' } };

    test.each([
        ['an empty cell', null],
        ['a cell with only a fill', { bg: '#f00' }],
    ])('%s leaves a number showing as General', (_, source) => {
        expect(painted(source, PERCENT)).toMatchObject({ v: 0.5, m: '0.5', ct: { fa: 'General', t: 'n' } });
    });

    test('a formula shows its number as General', () => {
        const cell = painted(null, { ...PERCENT, f: '=1/2' });
        expect(cell).toMatchObject({ f: '=1/2', v: 0.5, m: '0.5', ct: { fa: 'General', t: 'n' } });
    });

    test('text stays text', () => {
        const cell = painted(null, { v: '#N/A', m: '#N/A', ct: { fa: '@', t: 's' } });
        expect(cell).toMatchObject({ v: '#N/A', m: '#N/A', ct: { fa: 'General', t: 's' } });
    });

    test('a rich-text cell keeps its text', () => {
        const ct = { fa: 'General', t: 'inlineStr', s: [{ v: 'kept' }] };
        expect(painted(null, { ct })).toEqual({ ct });
    });

    test('a cell with nothing in it stays empty', () => {
        expect(painted(null, null)).toEqual({});
    });
});

describe('the format painter over a constant that is no number', () => {
    test.each([
        ['text from an apostrophe', { v: '005', m: '005', ct: { fa: 'General', t: 's' } }, 's'],
        ['text that reads as a number', { v: '005', m: '005', ct: { fa: 'General', t: 'g' } }, 'g'],
        ['text with no format', { v: 'abc', m: 'abc' }, 'g'],
        ['a boolean', { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } }, 'b'],
    ] as const)('%s keeps its type under a number format', (_, destination, t) => {
        const cell = painted(FORMATTED, { ...destination });
        expect(cell).toMatchObject({ v: destination.v, m: destination.m, ct: { fa: '0.00', t } });
    });

    test('a number stays a number under a text source', () => {
        const text: Cell = { v: 'x', m: 'x', ct: { fa: 'General', t: 's' } };
        expect(painted(text, { v: 2, m: '2', ct: { fa: 'General', t: 'n' } })).toMatchObject({ v: 2, ct: { t: 'n' } });
    });

    test('an empty cell takes the format and stays empty', () => {
        expect(painted(FORMATTED, null)).toEqual({ ct: FORMATTED.ct });
    });
});
