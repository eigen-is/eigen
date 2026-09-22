// applyOp keeps the formula dependency map in step with a peer's cell edits: the map counts
// as built once it exists, so a formula that arrives over the wire is only tracked if
// applyOp registers it.

import { describe, expect, it } from 'bun:test';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { emitOps } from '../../state/factories/collab';
import { contextFactory } from '../../state/factories/context';
import { edit, sel, typed } from '../../state/factories/edit-cycle';

function makeCtx(b1: Cell | null): Context {
    const data: (Cell | null)[][] = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = b1;
    return contextFactory({
        currentSheetId: 'id_1',
        selections: sel(0, 0, 0, 0),
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                data,
                calcChain: b1?.f ? [{ r: 0, c: 1, id: 'id_1' }] : [],
            },
        ],
    }) as Context;
}

// The peer types `value` into B1 on its own copy; the local client, map already built, applies the ops.
function receivePeerEdit(b1: Cell | null, value: string): Context {
    const ops = emitOps(makeCtx(b1), typed(0, 1, value));
    let ctx = makeCtx(b1);
    warmFormulaCellInfoMap(ctx);
    // biome-ignore lint/suspicious/noExplicitAny: applyOp reads settings only on the addSheet branch
    const settings = {} as any;
    const setContext = (recipe: (draft: Context) => void) => {
        ctx = produce(ctx, recipe);
    };
    generateAPIs(
        ctx,
        setContext,
        () => {},
        () => {},
        settings,
    ).applyOp(ops);
    return ctx;
}

describe('applyOp and the formula dependency map', () => {
    it("tracks a peer's new formula", () => {
        let ctx = receivePeerEdit(null, '=A1*2');
        expect(ctx.sheets[0].data![0][1]?.f).toBe('=A1*2');

        [ctx] = edit(ctx, typed(0, 0, '7'));

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14);
    });

    it('stops tracking a formula a peer overwrote with a value', () => {
        let ctx = receivePeerEdit({ f: '=A1*2', v: 10, m: '10' }, '3');
        expect(ctx.sheets[0].data![0][1]?.f).toBeUndefined();

        [ctx] = edit(ctx, typed(0, 0, '7'));

        expect(ctx.sheets[0].data![0][1]?.f).toBeUndefined();
        expect(ctx.sheets[0].data![0][1]?.v).toBe(3);
    });
});
