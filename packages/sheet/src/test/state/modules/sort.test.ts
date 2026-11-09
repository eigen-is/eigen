// Sorting has two layers: the pure `sortedOrder` comparator (numeric, 'en' text,
// nulls last) and `sortRange`, which picks the rows then delegates. These
// pin which rows the sort covers: a leading CJK cell sorts like any other value
// with no header-guessing, a header row stays only when the caller says so, and
// a merged cell stops the sort.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
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
