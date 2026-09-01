// The two halves of the collab round trip, shared by every test that needs a second client.
// Mirrors Workbook: setContextWithProduce keeps the syncable patches and emits them as ops,
// applyOp turns a peer's ops back into patches. Kept together because a test that uses one
// almost always uses the other, and because the pair is what makes divergence visible.

import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import type { Op } from '../../../state/types';
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
