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
import type { Context } from '../../../state/context';
import { getBorderInfoCompute } from '../../../state/modules/border';
import { handleBorder } from '../../../state/modules/toolbar';
import { clientAfterExchange, emitOps } from '../factories/collab';
import { contextFactory } from '../factories/context';

const sharedDocument = () => contextFactory({ config: { borderInfo: [] } }) as Context;

const borderCell = (row: number, column: number, color: string) => (ctx: Context) => {
    ctx.selections = [{ row: [row, row], column: [column, column] }];
    handleBorder(ctx, 'border-all', color);
};

describe('two clients bordering different cells', () => {
    const a = borderCell(1, 1, '#ff0000');
    const b = borderCell(2, 2, '#0000ff');

    // test.failing: this is N2's specification, red on purpose until borderInfo is re-shaped.
    // Flip back to `test` in the commit that makes it pass.
    test.failing('converge on the same stored borderInfo', () => {
        const base = sharedDocument();
        const onA = clientAfterExchange(base, a, emitOps(base, b));
        const onB = clientAfterExchange(base, b, emitOps(base, a));

        expect(onA.sheets[0].config?.borderInfo).toEqual(onB.sheets[0].config?.borderInfo ?? []);
    });

    test('converge on the same rendered borders', () => {
        const base = sharedDocument();
        const onA = clientAfterExchange(base, a, emitOps(base, b));
        const onB = clientAfterExchange(base, b, emitOps(base, a));

        expect(getBorderInfoCompute(onA)).toEqual(getBorderInfoCompute(onB));
    });

    test("neither client loses the other's border", () => {
        const base = sharedDocument();
        const computed = getBorderInfoCompute(clientAfterExchange(base, a, emitOps(base, b)));

        expect(computed['1_1']).toBeDefined();
        expect(computed['2_2']).toBeDefined();
    });
});
