// Regression: refreshing the grid must not crash when a *non-active* sheet has
// a formula at a row beyond the active sheet's bounds. Repro: select-all +
// delete on a small sheet while a taller sheet holds a formula in, say, column
// E. The delete clears the active sheet's formulaCellInfoMap entries, forcing
// execFunctionGroup to rebuild the map over the whole workbook's calc chain
// (getAllFunctionGroup spans every sheet). getcellFormula then indexed the
// active sheet's data with the *other* sheet's (r,c), throwing
// "Cannot read properties of undefined (reading '4')".

import { describe, expect, it } from 'bun:test';
import type { Context } from '../../context';
import { jfrefreshgrid } from '../../modules/refresh';
import { deleteSelectedCellText, selectAll } from '../../modules/selection';
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
