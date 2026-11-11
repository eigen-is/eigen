// One editor cycle the way Workbook runs it: the recipe inside produceWithPatches, the syncable patches kept as history, undo/redo applying them and
// then followPatches. For tests of the formula dependency map across edits.

import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import { copy } from '../../../state/modules/clipboard';
import type { History } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';
import { pasteCopy } from './clipboard';

enablePatches();

export function edit(ctx: Context, recipe: (draft: Context) => void): [Context, History] {
    const [next, patches, inversePatches] = produceWithPatches(ctx, recipe);
    return [next, { patches: filterPatch(patches), inversePatches: filterPatch(inversePatches), options: {} }];
}

export function undo(ctx: Context, history: History): Context {
    const next = applyPatches(ctx, history.inversePatches);
    next.formulaCache.followPatches(next, history.inversePatches);
    return next;
}

export function redo(ctx: Context, history: History): Context {
    const next = applyPatches(ctx, history.patches);
    next.formulaCache.followPatches(next, history.patches);
    return next;
}

export function sel(r1: number, r2: number, c1: number, c2: number) {
    return [{ row: [r1, r2], column: [c1, c2], row_focus: r1, column_focus: c1 }];
}

export const typed = (r: number, c: number, value: string) => (draft: Context) => {
    draft.selections = sel(r, c, r, c);
    updateCell(draft, r, c, null, value);
};

export const pasteInternal = (from: [number, number], to: [number, number]) => (draft: Context) => {
    draft.selections = sel(from[0], from[0], from[1], from[1]);
    copy(draft, { cut: false });
    draft.selections = sel(to[0], to[0], to[1], to[1]);
    pasteCopy(draft);
};
