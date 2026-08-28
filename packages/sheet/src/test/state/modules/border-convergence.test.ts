// Two clients apply a border to DIFFERENT cells of one sheet, then exchange ops. Both must
// end up rendering the same borders.
//
// They don't. `handleBorder` appends to `config.borderInfo`, an array, so both clients emit
// `add ['config','borderInfo',N]` for the same N. Each applies its own edit locally and skips
// it when it returns from Yjs (`isLocalOpRef`, apps/sheets/.../use-sheet.ts), so each then
// inserts the peer's entry BEFORE its own. Array order is semantic here — the replay in
// getBorderInfoComputeRange lets later entries override earlier ones, and `border-none`
// entries delete — so the two clients disagree about which border won, permanently.
//
// A map keyed "r_c" fixes exactly this case: different cells are different keys, so neither
// client's entry can displace the other's. It does NOT fix two clients editing the SAME cell —
// probed with borderInfo already a map, and the shared cell still diverges, because each client
// applies its own op optimistically and never replays in Yjs's total order. That one needs real
// Yjs structures for config; see docs/proposals. This pins only what re-shaping can deliver.

import { describe, expect, test } from 'bun:test';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { getBorderInfoCompute } from '../../../state/modules/border';
import { handleBorder } from '../../../state/modules/toolbar';
import type { Op } from '../../../state/types';
import { filterPatch, opToPatch, patchToOp } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

function sharedDocument(): Context {
    return contextFactory({ config: { borderInfo: [] } }) as Context;
}

function edit(base: Context, recipe: (ctx: Context) => void): Op[] {
    const [next, patches] = produceWithPatches(base, recipe);
    return patchToOp(next, filterPatch(patches));
}

function receive(ctx: Context, ops: Op[]): Context {
    return produce(ctx, (draft: Context) => {
        const [patches] = opToPatch(draft, ops);
        applyPatches(draft, patches);
    });
}

// Mirrors the client: apply your own edit locally, then take the peer's op.
function client(base: Context, mine: (ctx: Context) => void, theirs: Op[]): Context {
    return receive(produce(base, mine), theirs);
}

function borderRange(r1: number, r2: number, c1: number, c2: number, color: string) {
    return (ctx: Context) => {
        ctx.selections = [{ row: [r1, r2], column: [c1, c2] }];
        handleBorder(ctx, 'border-all', color);
    };
}

const borderCell = (row: number, column: number, color: string) => borderRange(row, row, column, column, color);

describe('two clients bordering different cells', () => {
    test('converge on the same stored borderInfo', () => {
        const base = sharedDocument();
        const a = borderCell(1, 1, '#ff0000');
        const b = borderCell(2, 2, '#0000ff');

        const onA = client(base, a, edit(base, b));
        const onB = client(base, b, edit(base, a));

        expect(onA.sheets[0].config?.borderInfo).toEqual(onB.sheets[0].config?.borderInfo ?? []);
    });

    test('converge on the same rendered borders', () => {
        const base = sharedDocument();
        const a = borderCell(1, 1, '#ff0000');
        const b = borderCell(2, 2, '#0000ff');

        const onA = client(base, a, edit(base, b));
        const onB = client(base, b, edit(base, a));

        expect(getBorderInfoCompute(onA)).toEqual(getBorderInfoCompute(onB));
    });

    test("neither client loses the other's border", () => {
        const base = sharedDocument();
        const onA = client(base, borderCell(1, 1, '#ff0000'), edit(base, borderCell(2, 2, '#0000ff')));

        const computed = getBorderInfoCompute(onA);
        expect(computed['1_1']).toBeDefined();
        expect(computed['2_2']).toBeDefined();
    });
});
