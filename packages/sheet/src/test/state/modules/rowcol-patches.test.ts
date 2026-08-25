// Regression: state row/col reducers must mutate ctx.sheets per-sheet,
// never reassign the whole array. Wholesale reassignment makes immer emit a
// synthetic { op: 'replace', path: ['sheets'], value: [...] } patch
// carrying the entire post-mutation Sheet[]. That patch:
//   - has no sheet id, so opToPatchOnSheets can't map it to a Sheet[]-rooted
//     index and used to throw immer error 14 in replaySheetsOps;
//   - bloats every collab update for a row/col edit with a copy of the whole
//     workbook even though the paired insertRowCol/deleteRowCol special op
//     already encodes the change.
// We now drop the synthetic patch defensively in opToPatchOnSheets, but the
// fix at the source is "don't emit it in the first place." This test fails
// the moment someone reintroduces `ctx.sheets = ...`.

import { describe, expect, test } from 'bun:test';
import { enablePatches, type Patch, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { contextFactory } from '../factories/context';

enablePatches();

function isWholesaleSheetsPatch(p: Patch): boolean {
    return p.path.length === 1 && p.path[0] === 'sheets';
}

function patchesFor(recipe: (ctx: Context) => void): Patch[] {
    const base = contextFactory() as Context;
    const [, patches] = produceWithPatches(base, recipe);
    return patches;
}

describe('row/col reducers emit per-sheet patches, not wholesale sheets replace', () => {
    test('insertRowCol does not emit a wholesale ["sheets"] replace', () => {
        const patches = patchesFor((ctx) => {
            insertRowCol(ctx, { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' }, false);
        });
        const wholesale = patches.filter(isWholesaleSheetsPatch);
        expect(wholesale).toEqual([]);
    });

    test('deleteRowCol does not emit a wholesale ["sheets"] replace', () => {
        const patches = patchesFor((ctx) => {
            deleteRowCol(ctx, { type: 'row', start: 0, end: 0, id: 'id_1' });
        });
        const wholesale = patches.filter(isWholesaleSheetsPatch);
        expect(wholesale).toEqual([]);
    });

    test('insertRowCol patches target only the affected sheet', () => {
        // The factory has two sheets; inserting on id_1 should leave id_2 untouched.
        const patches = patchesFor((ctx) => {
            insertRowCol(ctx, { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' }, false);
        });
        const sheetIndices = new Set<number>();
        for (const p of patches) {
            if (p.path[0] === 'sheets' && typeof p.path[1] === 'number') {
                sheetIndices.add(p.path[1]);
            }
        }
        expect(sheetIndices.has(0)).toBe(true);
        expect(sheetIndices.has(1)).toBe(false);
    });
});
