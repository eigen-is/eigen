// Two tabs filter one sheet and trade ops through the Workbook's own applyOp. Each tab reads the criteria a peer's op
// wrote, so its next filter edit shows and hides the right rows, and the op it sends leaves alone what the peer did.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { clearFilter, saveFilter } from '../../../state/modules/filter';
import type { Op } from '../../../state/types';
import type { Tab } from '../factories/collab';
import { tab, tabEdit, tabReceive } from '../factories/collab';
import { contextFactory } from '../factories/context';

function twoTabs(): [Tab, Tab] {
    const ctx = contextFactory({ config: { rowhidden: {} } }) as Context;
    ctx.sheets[0].data = Array.from({ length: 6 }, () => [{ v: 1 }, { v: 2 }]);
    ctx.sheets[0].filterRange = { row: [0, 5], column: [0, 1] };
    return [tab(ctx), tab(ctx)];
}

// The choice as the filter menu saves it: no rows means no filter on that column.
const filterColumn = (col: number, rows: number[]) => (ctx: Context) =>
    saveFilter(ctx, rows.length > 0, Object.fromEntries(rows.map((r) => [r, 0])), undefined, 0, 5, col, 0, 1);

const hiddenRows = (t: Tab) => Object.keys(t.ctx.sheets[0].config?.rowhidden ?? {}).map(Number);

// What an op does to the hidden rows: its kind and its row.
const rowOps = (ops: Op[]) =>
    ops.filter((op) => op.path[0] === 'config' && op.path[1] === 'rowhidden').map((op) => [op.op, Number(op.path[2])]);

function peerFilters(peer: Tab, me: Tab, col: number, rows: number[]) {
    tabReceive(me, tabEdit(peer, filterColumn(col, rows)));
}

describe("a tab's filter edit after a peer's", () => {
    test("the peer's filter lands on the sheet and hides its rows", () => {
        const [peer, me] = twoTabs();
        peerFilters(peer, me, 0, [1, 2]);
        expect(hiddenRows(me)).toEqual([1, 2]);
        expect(me.ctx.sheets[0].filter?.[0]?.rowhidden).toEqual({ 1: 0, 2: 0 });
    });

    test("changing the same column shows the peer's rows again, on both tabs", () => {
        const [peer, me] = twoTabs();
        peerFilters(peer, me, 0, [1, 2]);

        const edit = tabEdit(me, filterColumn(0, [3]));
        expect(rowOps(edit)).toEqual([
            ['remove', 1],
            ['remove', 2],
            ['add', 3],
        ]);
        tabReceive(peer, edit);
        expect(hiddenRows(me)).toEqual([3]);
        expect(hiddenRows(peer)).toEqual([3]);
    });

    test("clearing the filter shows the peer's rows again", () => {
        const [peer, me] = twoTabs();
        peerFilters(peer, me, 0, [1, 2]);
        tabEdit(me, clearFilter);
        expect(hiddenRows(me)).toEqual([]);
        expect(me.ctx.sheets[0].filterRange).toBeUndefined();
    });

    test("removing a column's filter keeps a row the peer's filter on another column hides too", () => {
        const [peer, me] = twoTabs();
        tabReceive(peer, tabEdit(me, filterColumn(1, [2, 3])));
        peerFilters(peer, me, 0, [2]);
        expect(rowOps(tabEdit(me, filterColumn(1, [])))).toEqual([['remove', 3]]);
        expect(hiddenRows(me)).toEqual([2]);
    });

    test('a filter a peer removed does not hide its rows again', () => {
        const [peer, me] = twoTabs();
        tabReceive(peer, tabEdit(me, filterColumn(0, [1])));
        peerFilters(peer, me, 0, []);
        expect(rowOps(tabEdit(me, filterColumn(1, [2])))).toEqual([['add', 2]]);
        expect(hiddenRows(me)).toEqual([2]);
    });

    test('a row a peer showed by hand stays shown when another column is filtered', () => {
        const [peer, me] = twoTabs();
        peerFilters(peer, me, 0, [1, 2]);
        tabReceive(me, [{ id: 'id_1', op: 'remove', path: ['config', 'rowhidden', '1'] }]);
        expect(rowOps(tabEdit(me, filterColumn(1, [3])))).toEqual([['add', 3]]);
        expect(hiddenRows(me)).toEqual([2, 3]);
    });
});
