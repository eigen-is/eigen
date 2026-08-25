// Regression: refreshing the grid must not crash when a *non-active* sheet has
// a formula at a row beyond the active sheet's bounds. Repro: select-all +
// delete on a small sheet while a taller sheet holds a formula in, say, column
// E. The delete clears the active sheet's formulaCellInfoMap entries, forcing
// execFunctionGroup to rebuild the map over the whole workbook's calc chain
// (getAllFunctionGroup spans every sheet). getcellFormula then indexed the
// active sheet's data with the *other* sheet's (r,c), throwing
// "Cannot read properties of undefined (reading '4')".

import { describe, expect, it } from 'bun:test';
import type { Context } from '../../../state/context';
import { jfrefreshgrid } from '../../../state/modules/refresh';
import { deleteSelectedCellText, selectAll } from '../../../state/modules/selection';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

// 11 rows x 5 cols, with a formula in column E (c=4) at row 10.
function tallSheetData() {
    return Array.from({ length: 11 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => (r === 10 && c === 4 ? { f: '=1+1', v: 2 } : null)),
    );
}

describe('jfrefreshgrid across a multi-sheet calc chain', () => {
    it('does not crash when another sheet has a formula beyond the active sheet bounds', () => {
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'active',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [null, null, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                    ],
                },
                {
                    name: 'tall',
                    id: 'id_2',
                    order: 1,
                    data: tallSheetData(),
                    calcChain: [{ r: 10, c: 4, id: 'id_2' }],
                },
            ],
        }) as Context;

        // Mirror the keyboard handler: ctrl-a, delete, then refresh the grid.
        selectAll(ctx);
        deleteSelectedCellText(ctx);

        expect(() => jfrefreshgrid(ctx, null, undefined)).not.toThrow();

        // The other sheet's formula must still be resolved against *its own*
        // data, not silently dropped.
        expect(ctx.formulaCache.formulaCellInfoMap?.['r10c4iid_2']).toBeDefined();
    });
});

describe('delete refreshes only the cells it actually changed', () => {
    it('tracks content cells (not the whole selection) and still recomputes dependents outside the range', () => {
        // 1000-row sheet, but only A1 holds a value; C1 (column C, not selected)
        // is a formula that depends on A1.
        const data: (Cell | null)[][] = Array.from({ length: 1000 }, () => [null, null, null, null]);
        data[0][0] = { v: 5, m: '5' };
        data[0][2] = { f: '=A1*2', v: 10, m: '10' };

        const ctx = contextFactory({
            currentSheetId: 'id_1',
            // Select all of column A (rows 0..999); C1 in column C stays unselected.
            selections: [{ row: [0, 999], column: [0, 0], row_focus: 0, column_focus: 0 }],
            sheets: [{ name: 'active', id: 'id_1', order: 0, data, calcChain: [{ r: 0, c: 2, id: 'id_1' }] }],
        }) as Context;

        deleteSelectedCellText(ctx);

        // 1000 cells were selected, but only A1 had content — that's all we track.
        expect(ctx.formulaCache.pendingChangedCells).toEqual([{ r: 0, c: 0, id: 'id_1' }]);

        // Same call the keyboard handler makes after a delete.
        jfrefreshgrid(ctx, null, undefined);

        // C1 (=A1*2) lives outside the deleted column yet must recompute to 0.
        const c1 = ctx.groupValuesRefreshData.find((e) => e.r === 0 && e.c === 2 && e.id === 'id_1');
        expect(c1).toBeDefined();
        expect(c1?.v).toBe(0);
    });
});
