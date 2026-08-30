// Two clients apply a border to DIFFERENT cells of one sheet, then exchange ops. Both must
// end up with the same stored borders and render the same.
//
// With `config.borderInfo` an array they did not: both clients emitted
// `add ['config','borderInfo',N]` for the same N, each applied its own edit locally and skipped
// it when it returned from Yjs (`isLocalOpRef`, apps/sheets/.../use-sheet.ts), so each inserted
// the peer's entry BEFORE its own — and array order was semantic (later entries overrode
// earlier ones on replay), so the two clients disagreed about which border won, permanently.
//
// The map keyed "r_c" fixes exactly this case: different cells are different keys, so neither
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

const sharedDocument = () => contextFactory({ config: { borderInfo: {} } }) as Context;
const computed = (ctx: Context) => getBorderInfoCompute(ctx, ctx.currentSheetId, [0, 3, 0, 3]);

const borderCell = (row: number, column: number, color: string) => (ctx: Context) => {
    ctx.selections = [{ row: [row, row], column: [column, column] }];
    handleBorder(ctx, 'border-all', color);
};

describe('two clients bordering different cells', () => {
    const a = borderCell(1, 1, '#ff0000');
    const b = borderCell(2, 2, '#0000ff');

    test('converge on the same stored borderInfo', () => {
        const base = sharedDocument();
        const onA = clientAfterExchange(base, a, emitOps(base, b));
        const onB = clientAfterExchange(base, b, emitOps(base, a));

        expect(onA.sheets[0].config?.borderInfo).toEqual(onB.sheets[0].config?.borderInfo);
    });

    test('converge on the same rendered borders', () => {
        const base = sharedDocument();
        const onA = clientAfterExchange(base, a, emitOps(base, b));
        const onB = clientAfterExchange(base, b, emitOps(base, a));

        expect(computed(onA)).toEqual(computed(onB));
    });

    test("neither client loses the other's border", () => {
        const base = sharedDocument();
        const map = computed(clientAfterExchange(base, a, emitOps(base, b)));

        expect(map['1_1']).toBeDefined();
        expect(map['2_2']).toBeDefined();
    });
});
