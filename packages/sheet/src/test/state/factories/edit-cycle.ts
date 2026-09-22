// One editor cycle the way Workbook runs it: the recipe and groupValuesRefresh inside
// produceWithPatches, the syncable patches kept as history, undo/redo applying them and
// then updateFormulaCache. For tests of the formula dependency map across edits.

import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { handlePasteByClick } from '../../../state/events/paste';
import { updateCell } from '../../../state/modules/cell';
import { groupValuesRefresh } from '../../../state/modules/formula-exec';
import { copy } from '../../../state/modules/selection';
import type { History } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';

enablePatches();

export function edit(ctx: Context, recipe: (draft: Context) => void): [Context, History] {
    const [next, patches, inversePatches] = produceWithPatches(ctx, (draft: Context) => {
        recipe(draft);
        if (draft.groupValuesRefreshData.length > 0) groupValuesRefresh(draft);
    });
    return [next, { patches: filterPatch(patches), inversePatches: filterPatch(inversePatches) }];
}

export function undo(ctx: Context, history: History): Context {
    const next = applyPatches(ctx, history.inversePatches);
    next.formulaCache.updateFormulaCache(next, history, 'undo');
    return next;
}

export function redo(ctx: Context, history: History): Context {
    const next = applyPatches(ctx, history.patches);
    next.formulaCache.updateFormulaCache(next, history, 'redo');
    return next;
}

export function sel(r1: number, r2: number, c1: number, c2: number) {
    return [{ row: [r1, r2], column: [c1, c2], row_focus: r1, column_focus: c1 }];
}

export const typed = (r: number, c: number, value: string) => (draft: Context) => {
    draft.selections = sel(r, c, r, c);
    updateCell(draft, r, c, null, value);
};

// copy() writes the plain-text clipboard, so a caller mocks document and sessionStorage.
export const pasteInternal = (from: [number, number], to: [number, number]) => (draft: Context) => {
    draft.selections = sel(from[0], from[0], from[1], from[1]);
    copy(draft);
    draft.pasteIsCut = false;
    draft.selections = sel(to[0], to[0], to[1], to[1]);
    handlePasteByClick(draft, 'internal');
};
