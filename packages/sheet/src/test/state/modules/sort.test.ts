// Sorting has two layers: the pure `sortedOrder` comparator (numeric, 'en' text,
// nulls last) and `sortRange`, which picks the rows then delegates. These
// pin which rows the sort covers: a leading CJK cell sorts like any other value
// with no header-guessing, a header row stays only when the caller says so, and
// a merged cell stops the sort.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { sortFilterRange } from '../../../state/modules/filter';
import { sortedOrder, sortRange, sortSelection } from '../../../state/modules/sort';
import { contextFactory, selectionFactory } from '../factories/context';

const cell = (v: Cell['v']): Cell => ({ v, m: String(v) });
const sorted = (isAsc: boolean, rows: (Cell | null)[][]) => sortedOrder(isAsc, 0, rows).map((i) => rows[i]);

describe('sortedOrder', () => {
    test('numeric ascending keeps nulls last', () => {
        const rows = [[cell(3)], [cell(1)], [null], [cell(2)]];
        expect(sorted(true, rows).map((r) => r[0]?.v ?? null)).toEqual([1, 2, 3, null]);
    });

    test('numeric descending keeps nulls last', () => {
        const rows = [[cell(3)], [cell(1)], [null], [cell(2)]];
        expect(sorted(false, rows).map((r) => r[0]?.v ?? null)).toEqual([3, 2, 1, null]);
    });

    test("text compares with the 'en' locale", () => {
        const rows = [[cell('banana')], [cell('apple')], [cell('cherry')]];
        expect(sorted(true, rows).map((r) => r[0]?.v)).toEqual(['apple', 'banana', 'cherry']);
    });

    test("says each row's old place, and sorts a large range in linear time per row", () => {
        const rows = [[cell(30)], [cell(10)], [cell(20)]];
        expect(sortedOrder(true, 0, rows)).toEqual([1, 2, 0]);

        // Reversed, so every row moves. Finding each row's old place by a search made this quadratic, seconds long.
        const count = 50_000;
        const large = Array.from({ length: count }, (_, i) => [cell(count - i)]);
        const started = performance.now();
        const order = sortedOrder(true, 0, large);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(order[0]).toBe(count - 1);
        expect(order[count - 1]).toBe(0);
    });
});

// Rows 1 to 4 under a header hold d, a, c, b. A hidden row keeps its cells, or the row that shows after the sort is
// another row than the one the filter or the user chose.
describe('a sort over hidden rows', () => {
    const hiddenCtx = (rowhidden: Record<string, number>, filter = {}) =>
        contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: { rowhidden },
                    filter,
                    filterRange: { row: [0, 4], column: [0, 1] },
                    data: [
                        [cell('head'), cell('n')],
                        [cell('d'), cell(4)],
                        [cell('a'), cell(1)],
                        [cell('c'), cell(3)],
                        [cell('b'), cell(2)],
                    ],
                },
            ],
        }) as Context;
    const column = (ctx: Context) => ctx.sheets[0].data?.map((row) => row[0]?.v);

    test('the filter menu sort leaves the rows the filter hides where they are', () => {
        const hidden = { 2: 0 };
        const entry = { rowhidden: hidden, optionstate: true, str: 0, edr: 4, cindex: 0, stc: 0, edc: 1 };
        const next = produce(hiddenCtx(hidden, { 0: entry }), (draft: Context) => {
            sortFilterRange(draft, 0, 0, 4, 1, 0, true);
        });
        expect(column(next)).toEqual(['head', 'b', 'a', 'c', 'd']);
        expect(next.sheets[0].config?.rowhidden).toEqual(hidden);
    });

    test('a sort of a range leaves a row hidden by hand where it is', () => {
        const next = produce(hiddenCtx({ 1: 0 }), (draft: Context) =>
            sortRange(draft, { row: [1, 4], column: [0, 1] }, true),
        );
        expect(column(next)).toEqual(['head', 'd', 'a', 'b', 'c']);
    });

    test('a formula follows its row across a hidden row', () => {
        const ctx = hiddenCtx({ 2: 0 });
        const row = ctx.sheets[0].data?.[1];
        if (row) row[1] = { v: 4, m: '4', f: '=4*B4/B4' };
        const next = produce(ctx, (draft: Context) => sortRange(draft, { row: [1, 4], column: [0, 1] }, true));
        expect(column(next)).toEqual(['head', 'b', 'a', 'c', 'd']);
        expect(next.sheets[0].data?.[4]?.[1]?.f).toBe('=4*B7/B7');
    });
});

describe('sortRange — CJK rows participate', () => {
    test('a leading CJK cell is included in the sort range', () => {
        const data: (Cell | null)[][] = [
            [cell('要'), cell(3), null, null],
            [cell('x'), cell(1), null, null],
            [cell('y'), cell(2), null, null],
            [null, null, null, null],
        ];
        const ctx = contextFactory({
            sheets: [{ name: 'sheet', id: 'id_1', data, order: 0 }],
        }) as Context;

        // Sort ascending by column 1 (values 3,1,2 → 1,2,3). If the CJK row in
        // column 0 is excluded, row 0 stays put; if included, it moves to the end.
        const next = produce(ctx, (draft: Context) => sortRange(draft, { row: [0, 2], column: [0, 1] }, true, 1));

        const d = next.sheets[0].data!;
        expect(d[0]?.[1]?.v).toBe(1);
        expect(d[2]?.[0]?.v).toBe('要');
    });
});

describe('sortRange — a header row', () => {
    const data = (): (Cell | null)[][] => [
        [cell('Name'), cell('Score')],
        [cell('b'), cell(2)],
        [cell('c'), cell(3)],
        [cell('a'), cell(1)],
    ];
    const sorted = (hasHeaderRow?: boolean) => {
        const ctx = contextFactory({
            sheets: [{ name: 'sheet', id: 'id_1', data: data(), order: 0 }],
        }) as Context;
        const next = produce(ctx, (draft: Context) =>
            sortRange(draft, { row: [0, 3], column: [0, 1] }, true, 1, hasHeaderRow),
        );
        return next.sheets[0].data?.map((row) => row[0]?.v);
    };

    test('stays in place and only the rows below it sort', () => {
        expect(sorted(true)).toEqual(['Name', 'a', 'b', 'c']);
    });

    // The Data menu's Ascending and Descending pass none, so a text first row sorts after the numbers.
    test('sorts with the rest when none is passed', () => {
        expect(sorted()).toEqual(['a', 'b', 'c', 'Name']);
    });
});

test('sortSelection leaves a range that holds a merged cell as it is', () => {
    const data: (Cell | null)[][] = [
        [cell('b'), { ...cell(2), mc: { r: 0, c: 1, rs: 2, cs: 1 } }],
        [cell('a'), { mc: { r: 0, c: 1 } }],
    ];
    const ctx = contextFactory({
        selections: selectionFactory([0, 1], [0, 1], 0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', data, order: 0 }],
    }) as Context;
    sortSelection(ctx, true);
    expect(ctx.sheets[0].data?.map((row) => row[0]?.v)).toEqual(['b', 'a']);
});
