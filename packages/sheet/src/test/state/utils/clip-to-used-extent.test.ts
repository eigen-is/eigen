// clipToUsedExtent bounds a header-click (whole-row / whole-column) selection to the used
// extent so Insert -> Tick box and border-all don't materialize cells past the data. The
// bordered-extent scan must respect the selection's fixed axis: a border far down in ANOTHER
// column must not stretch a whole-column selection's rows (a regression that made insertCheckbox
// seed thousands of empty cells).

import { describe, expect, test } from 'bun:test';
import type { Context, Selection } from '../../../state/index';
import { clipToUsedExtent } from '../../../state/utils';
import { contextFactory } from '../factories/context';

const SIDE = { style: 1, color: '#000' };

// 500 rows x 4 columns, data only in rows 0-`usedThrough` of column `dataCol`.
function sheet(usedThrough: number, dataCol: number, borderInfo: Record<string, typeof SIDE | object>): Context {
    const ctx = contextFactory({ config: { borderInfo: borderInfo as never } }) as Context;
    ctx.sheets[0].data = Array.from({ length: 500 }, (_, r) =>
        Array.from({ length: 4 }, (_, c) => (r <= usedThrough && c === dataCol ? { v: 'x', m: 'x' } : null)),
    );
    ctx.visibledatarow = Array.from({ length: 500 }, (_, r) => (r + 1) * 20);
    ctx.visibledatacolumn = Array.from({ length: 4 }, (_, c) => (c + 1) * 74);
    return ctx;
}

const wholeColumn = (col: number): Selection => ({
    row: [0, 499],
    column: [col, col],
    row_focus: 0,
    column_focus: col,
});
const wholeRow = (row: number): Selection => ({ row: [row, row], column: [0, 3], row_focus: row, column_focus: 0 });

describe('clipToUsedExtent respects the selection fixed axis', () => {
    test('a border in another column does not stretch a whole-column selection', () => {
        const ctx = sheet(4, 2, { '400_3': SIDE });
        expect(clipToUsedExtent(ctx, [wholeColumn(2)])[0].row).toEqual([0, 4]);
    });

    test('a border in the selected column does stretch it', () => {
        const ctx = sheet(4, 2, { '400_2': SIDE });
        expect(clipToUsedExtent(ctx, [wholeColumn(2)])[0].row).toEqual([0, 400]);
    });

    test('a border in another row does not stretch a whole-row selection', () => {
        const ctx = sheet(4, 0, { '400_3': SIDE });
        expect(clipToUsedExtent(ctx, [wholeRow(7)])[0].column).toEqual([0, 0]);
    });

    test('a border in the selected row does stretch it', () => {
        const ctx = sheet(4, 0, { '7_3': SIDE });
        expect(clipToUsedExtent(ctx, [wholeRow(7)])[0].column).toEqual([0, 3]);
    });
});
