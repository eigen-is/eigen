// The two halves of the collab round trip, shared by every test that needs a second client.
// Mirrors Workbook: setContextWithProduce keeps the syncable patches and emits them as ops,
// applyOp turns a peer's ops back into patches. Kept together because a test that uses one
// almost always uses the other, and because the pair is what makes divergence visible.

import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '@workspace/lib/sheets';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { replaySheetsOps } from '../../../engine';
import type { Context } from '../../../state/context';
import { FormulaCache } from '../../../state/modules/formula-cache';
import { groupValuesRefresh } from '../../../state/modules/formula-exec';
import { recordEntry, redoEntry, undoEntry } from '../../../state/modules/history';
import type { History, Op } from '../../../state/types';
import type { PatchOptions } from '../../../state/utils/patch';
import { filterPatch, opToPatch, patchToOp } from '../../../state/utils/patch';

enablePatches();

export function emitOps(base: Context, recipe: (ctx: Context) => void): Op[] {
    const [next, patches] = produceWithPatches(base, recipe);
    return patchToOp(next, filterPatch(patches));
}

export function receiveOps(ctx: Context, ops: Op[]): Context {
    return produce(ctx, (draft: Context) => {
        const [patches] = opToPatch(draft, ops);
        applyPatches(draft, patches);
    });
}

// One client's view after a concurrent round: apply your own edit locally, then take the
// peer's ops. Both clients branch from the same base, which is what makes them disagree.
export function clientAfterExchange(base: Context, mine: (ctx: Context) => void, theirs: Op[]): Context {
    return receiveOps(produce(base, mine), theirs);
}

export function syncablePaths(base: Context, recipe: (ctx: Context) => void) {
    const [, patches] = produceWithPatches(base, recipe);
    return filterPatch(patches).map((p) => p.path);
}

// One edit as setContextWithProduce records it: the new state, its ops and its undo entry.
export function author(base: Context, recipe: (ctx: Context) => void, options: PatchOptions = {}) {
    const [next, patches, inverse] = produceWithPatches(base, recipe);
    const entry = recordEntry(base, next, filterPatch(patches), filterPatch(inverse), options);
    return {
        next,
        ops: patchToOp(next, filterPatch(patches), entry.options),
        patches: filterPatch(patches),
        inverse: filterPatch(inverse),
        entry,
    };
}

// A peer applies a batch through the Workbook's own applyOp, which drops a batch that fails to apply and shifts the
// undo and redo stacks it is given.
export function receive(ctx: Context, ops: Op[], history: Tab['history'] = { undoList: [], redoList: [] }): Context {
    let next = ctx;
    const setContext = (recipe: (draft: Context) => void) => {
        next = produce(next, recipe);
    };
    generateAPIs(
        ctx,
        setContext,
        () => {},
        () => {},
        history,
    ).applyOp(ops);
    return next;
}

// One browser tab: its context and the undo and redo stacks Workbook keeps beside it.
export type Tab = { ctx: Context; history: { undoList: History[]; redoList: History[] } };

// Each tab builds its own formula map, as each browser does.
export const tab = (ctx: Context): Tab => ({
    ctx: produce(ctx, (draft: Context) => {
        draft.formulaCache = new FormulaCache();
    }),
    history: { undoList: [], redoList: [] },
});

// The tab's own edit, recorded as Workbook records it, recalculated dependents included; returns the batch it sends.
export function tabEdit(t: Tab, recipe: (ctx: Context) => void, options?: PatchOptions): Op[] {
    const recalculated = (ctx: Context) => {
        recipe(ctx);
        if (ctx.groupValuesRefreshData.length > 0) groupValuesRefresh(ctx);
    };
    const { next, ops, entry } = author(t.ctx, recalculated, options);
    t.ctx = next;
    t.history.undoList.push(entry);
    t.history.redoList = [];
    return ops;
}

export function tabReceive(t: Tab, ops: Op[]) {
    t.ctx = receive(t.ctx, ops, t.history);
}

// Workbook's handleUndo and handleRedo: the entry changes stacks, and the pure step makes the context and the batch.
export function tabUndo(t: Tab): Op[] {
    const entry = t.history.undoList.pop();
    if (!entry) return [];
    t.history.redoList.push(entry);
    const { ctx, ops } = undoEntry(t.ctx, entry);
    t.ctx = ctx;
    return ops;
}

export function tabRedo(t: Tab): Op[] {
    const entry = t.history.redoList.pop();
    if (!entry) return [];
    t.history.undoList.push(entry);
    const { ctx, ops } = redoEntry(t.ctx, entry);
    t.ctx = ctx;
    return ops;
}

// A joiner decodes the stored snapshot, stored cells and no matrix, and replays the batches on it, as a browser that
// opens the workbook and the server's read do.
export const join = (base: Context, batches: Op[][]) =>
    replaySheetsOps(decodeSheetsSnapshot(encodeSheetsSnapshot(base.sheets, { computed: true })), batches);
