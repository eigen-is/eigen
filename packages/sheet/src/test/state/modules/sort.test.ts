// Sorting has two layers: the pure `orderbydata` comparator (numeric, 'en' text,
// nulls last) and `sortSelection`, which picks the range then delegates. These
// pin that a leading CJK cell sorts like any other value — no header-guessing.

import { describe, expect, test } from 'bun:test';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { orderbydata, sortSelection } from '../../../state/modules/sort';
import { contextFactory, selectionFactory } from '../factories/context';

const cell = (v: Cell['v']): Cell => ({ v, m: String(v) });

describe('orderbydata', () => {
    test('numeric ascending keeps nulls last', () => {
        const rows = [[cell(3)], [cell(1)], [null], [cell(2)]];
        const { sortedData } = orderbydata(true, 0, rows);
        expect(sortedData.map((r) => r[0]?.v ?? null)).toEqual([1, 2, 3, null]);
    });

    test('numeric descending keeps nulls last', () => {
        const rows = [[cell(3)], [cell(1)], [null], [cell(2)]];
        const { sortedData } = orderbydata(false, 0, rows);
        expect(sortedData.map((r) => r[0]?.v ?? null)).toEqual([3, 2, 1, null]);
    });

    test("text compares with the 'en' locale", () => {
        const rows = [[cell('banana')], [cell('apple')], [cell('cherry')]];
        const { sortedData } = orderbydata(true, 0, rows);
        expect(sortedData.map((r) => r[0]?.v)).toEqual(['apple', 'banana', 'cherry']);
    });
});

describe('sortSelection — CJK rows participate', () => {
    test('a leading CJK cell is included in the sort range', () => {
        const data: (Cell | null)[][] = [
            [cell('要'), cell(3), null, null],
            [cell('x'), cell(1), null, null],
            [cell('y'), cell(2), null, null],
            [null, null, null, null],
        ];
        const ctx = contextFactory({
            selections: selectionFactory([0, 2], [0, 1], 0, 0),
            sheets: [{ name: 'sheet', id: 'id_1', data, order: 0 }],
        }) as Context;

        // Sort ascending by column 1 (values 3,1,2 → 1,2,3). If the CJK row in
        // column 0 is excluded, row 0 stays put; if included, it moves to the end.
        sortSelection(ctx, true, 1);

        const d = ctx.sheets[0].data!;
        expect(d[0]?.[1]?.v).toBe(1);
        expect(d[2]?.[0]?.v).toBe('要');
    });
});
