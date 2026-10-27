// Delete clears a cell's contents and keeps its format, as Excel and Google Sheets do: removing
// the format is the separate Clear formatting command.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { deleteSelectedCellText } from '../../../state/modules/selection';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

function deleteA1(cell: Cell, hyperlink?: Context['sheets'][number]['hyperlink']): Context {
    const ctx = contextFactory({
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    }) as Context;
    ctx.sheets[0].data = [[cell, null]];
    ctx.sheets[0].hyperlink = hyperlink;
    deleteSelectedCellText(ctx);
    return ctx;
}

describe('deleteSelectedCellText keeps the format', () => {
    test('a bold red value keeps its bold, color, fill and number format and loses its value', () => {
        const ctx = deleteA1({ v: 3.5, m: '3.50', ct: { fa: '0.00', t: 'n' }, bl: 1, fc: '#ff0000', bg: '#ffff00' });
        expect(ctx.sheets[0].data?.[0][0]).toEqual({ ct: { fa: '0.00', t: 'n' }, bl: 1, fc: '#ff0000', bg: '#ffff00' });
        expect(ctx.formulaCache.pendingChangedCells).toEqual([{ r: 0, c: 0, id: 'id_1' }]);
    });

    test('a formula goes with its value', () => {
        const ctx = deleteA1({ f: '=1+1', v: 2, m: '2', it: 1 });
        expect(ctx.sheets[0].data?.[0][0]).toEqual({ it: 1 });
    });

    test("a rich cell loses its runs and keeps the cell's own style", () => {
        const ctx = deleteA1({
            ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'a', bl: 1 }, { v: 'b' }] },
            fs: 14,
            ht: 0,
        });
        expect(ctx.sheets[0].data?.[0][0]).toEqual({ ct: { fa: 'General', t: 'g' }, fs: 14, ht: 0 });
    });

    test("a link goes with the link's look, and the cell's other format stays", () => {
        const ctx = deleteA1(
            { v: 'site', m: 'site', fc: 'rgb(0, 0, 255)', un: 1, hl: { r: 0, c: 0, id: 'id_1' }, bl: 1 },
            { '0_0': { linkType: 'webpage', linkAddress: 'https://example.com' } },
        );
        expect(ctx.sheets[0].data?.[0][0]).toEqual({ bl: 1 });
        expect(ctx.sheets[0].hyperlink?.['0_0']).toBeUndefined();
    });

    test('a comment stays on the cell', () => {
        const ctx = deleteA1({ v: 'x', m: 'x', commentCardIds: ['card'] });
        expect(ctx.sheets[0].data?.[0][0]).toEqual({ commentCardIds: ['card'] });
    });

    test('a formatted empty cell is left alone and counts as no change', () => {
        const cell: Cell = { bg: '#ffff00' };
        const ctx = deleteA1(cell);
        expect(ctx.sheets[0].data?.[0][0]).toBe(cell);
        expect(ctx.formulaCache.pendingChangedCells).toEqual([]);
    });
});
