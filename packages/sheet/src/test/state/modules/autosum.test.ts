// Autosum on a range writes straight into the cells past it or beside it, and on one cell opens the editor on the sum.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { autoSelectionFormula } from '../../../state';
import type { Context } from '../../../state/context';
import type { Cell } from '../../../state/types';
import { contextFactory, selectionFactory } from '../factories/context';

installHappyDom();

const number = (v: number): Cell => ({ v, m: String(v), ct: { fa: 'General', t: 'n' } });

function sumOver(cells: Record<string, Cell>, row: number[], column: number[]) {
    const ctx = contextFactory({
        selections: selectionFactory(row, column, row[0], column[0]),
        editingCellPosition: [],
    }) as Context;
    const data = ctx.sheets[0].data;
    if (!data) throw new Error('no data');
    for (const [key, cell] of Object.entries(cells)) {
        const [r, c] = key.split('_').map(Number);
        data[r][c] = cell;
    }
    const input = document.createElement('div');
    const bar = document.createElement('div');
    ctx.getRefs().cellInput.current = input;
    ctx.getRefs().fxInput.current = bar;
    autoSelectionFormula(ctx, input, bar, 'SUM');
    return { ctx, input, bar, f: (r: number, c: number) => data[r][c]?.f };
}

describe('autosum', () => {
    test('a column of numbers sums below it', () => {
        const { f } = sumOver({ '0_0': number(1), '1_0': number(2) }, [0, 1], [0, 0]);
        expect(f(2, 0)).toBe('=SUM(A1:A2)');
    });

    test('a row of numbers sums past its end', () => {
        const { f } = sumOver({ '0_0': number(1), '0_1': number(2) }, [0, 0], [0, 1]);
        expect(f(0, 2)).toBe('=SUM(A1:B1)');
    });

    test('the sum goes on to the first free cell', () => {
        const { f } = sumOver({ '0_0': number(1), '1_0': number(2), '2_0': number(9) }, [0, 1], [0, 0]);
        expect(f(2, 0)).toBeUndefined();
        expect(f(3, 0)).toBe('=SUM(A1:A2)');
    });

    test('a blank row sums each column above it', () => {
        const { f } = sumOver({ '0_0': number(1), '0_1': number(2) }, [1, 1], [0, 1]);
        expect(f(1, 0)).toBe('=SUM(A1)');
        expect(f(1, 1)).toBe('=SUM(B1)');
    });

    test('a blank column sums each row to its left', () => {
        const { f } = sumOver({ '0_0': number(1), '1_0': number(2) }, [0, 1], [1, 1]);
        expect(f(0, 1)).toBe('=SUM(A1)');
        expect(f(1, 1)).toBe('=SUM(A2)');
    });

    test('a block sums its rows and its columns', () => {
        const cells = { '0_0': number(1), '0_1': number(2), '1_0': number(3), '1_1': number(4) };
        const { f } = sumOver(cells, [0, 1], [0, 1]);
        expect(f(0, 2)).toBe('=SUM(A1:B1)');
        expect(f(1, 2)).toBe('=SUM(A2:B2)');
        expect(f(2, 0)).toBe('=SUM(A1:A2)');
        expect(f(2, 1)).toBe('=SUM(B1:B2)');
    });

    test('one cell under numbers opens on their sum, in the cell and the bar', () => {
        const { ctx, input, bar, f } = sumOver({ '0_0': number(1), '1_0': number(2) }, [2, 2], [0, 0]);
        expect(ctx.editingCellPosition).toEqual([2, 0]);
        expect(input.textContent).toBe('=SUM(A1:A2)');
        expect(bar.textContent).toBe('=SUM(A1:A2)');
        expect(f(2, 0)).toBeUndefined();
    });
});
