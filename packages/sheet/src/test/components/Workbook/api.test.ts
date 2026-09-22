// applyOp keeps the formula dependency map in step with a peer's cell edits: the map counts
// as built once it exists, so a formula that arrives over the wire is only tracked if
// applyOp registers it.

import { describe, expect, it } from 'bun:test';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import type { Op } from '../../../state/types';
import { emitOps } from '../../state/factories/collab';
import { contextFactory } from '../../state/factories/context';
import { edit, pasteInternal, sel, typed } from '../../state/factories/edit-cycle';

// copy() writes the plain-text clipboard through document and sessionStorage.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = { createElement: () => ({ innerHTML: '', innerText: '', textContent: '' }) };
g.sessionStorage = { setItem: () => {} };

// A1 = 5, B1 = b1.
function makeData(b1: Cell | null, rows = 4): (Cell | null)[][] {
    const data: (Cell | null)[][] = Array.from({ length: rows }, () => Array.from({ length: 4 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = b1;
    return data;
}

function makeCtx(b1: Cell | null, currentSheetId = 'id_1'): Context {
    const data = makeData(b1);
    return contextFactory({
        currentSheetId,
        selections: sel(0, 0, 0, 0),
        sheets: [
            { name: 'first', id: 'id_1', order: 0, data, calcChain: b1?.f ? [{ r: 0, c: 1, id: 'id_1' }] : [] },
            { name: 'second', id: 'id_2', order: 1, data: makeData(null), calcChain: [] },
        ],
    }) as Context;
}

function applyPeerOps(ctx: Context, ops: Op[]): Context {
    let next = ctx;
    // biome-ignore lint/suspicious/noExplicitAny: applyOp reads settings only on the addSheet branch
    const settings = {} as any;
    const setContext = (recipe: (draft: Context) => void) => {
        next = produce(next, recipe);
    };
    generateAPIs(
        ctx,
        setContext,
        () => {},
        () => {},
        settings,
    ).applyOp(ops);
    return next;
}

// The peer types `value` into B1 on its own copy; the local client, map already built, applies the ops.
function receivePeerEdit(b1: Cell | null, value: string, warm = true): Context {
    const ops = emitOps(makeCtx(b1), typed(0, 1, value));
    const ctx = makeCtx(b1);
    if (warm) warmFormulaCellInfoMap(ctx);
    return applyPeerOps(ctx, ops);
}

const key = (r: number, c: number, id: string) => `r${r}c${c}i${id}`;

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

    it('leaves an unbuilt map for its first use to build, peer formula included', () => {
        let ctx = receivePeerEdit(null, '=A1*2', false);
        expect(ctx.formulaCache.formulaCellInfoMap).toBeNull();

        [ctx] = edit(ctx, typed(0, 0, '7'));

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14);
    });

    it("registers a peer's formula on a sheet other than the current one", () => {
        const ops = emitOps(makeCtx(null, 'id_2'), typed(0, 1, '=A1*2'));
        const ctx = makeCtx(null);
        warmFormulaCellInfoMap(ctx);

        const next = applyPeerOps(ctx, ops);

        const map = next.formulaCache.formulaCellInfoMap!;
        expect(map[key(0, 1, 'id_2')]?.calc_funcStr).toBe('=A1*2');
        expect(map[key(0, 1, 'id_1')]).toBeUndefined();
    });

    // Clearing a formula ships the whole reassigned calcChain; the map only follows cell data.
    it('re-registers only the cell a peer typed over, not the whole calcChain', () => {
        const withColumn = (ctx: Context) => {
            const data = makeData({ f: '=A1*2', v: 10, m: '10' }, 50);
            for (let r = 1; r < 50; r += 1) data[r][1] = { f: `=A${r + 1}*2`, v: 0, m: '0' };
            ctx.sheets[0].data = data;
            ctx.sheets[0].calcChain = data.map((_, r) => ({ r, c: 1, id: 'id_1' }));
            return ctx;
        };
        const ops = emitOps(withColumn(makeCtx(null)), typed(0, 1, '3'));
        expect(ops.some((op) => op.path[0] === 'calcChain' && Array.isArray(op.value))).toBe(true);
        const ctx = withColumn(makeCtx(null));
        const before = { ...warmFormulaCellInfoMap(ctx) };

        const map = applyPeerOps(ctx, ops).formulaCache.formulaCellInfoMap!;

        expect(map[key(0, 1, 'id_1')]).toBeUndefined();
        for (let r = 1; r < 50; r += 1) expect(map[key(r, 1, 'id_1')]).toBe(before[key(r, 1, 'id_1')]);
    });

    it("tracks the formulas in rows a peer's paste appended", () => {
        const ops = emitOps(makeCtx({ f: '=A1*2', v: 10, m: '10' }), pasteInternal([0, 1], [5, 1]));
        let ctx = makeCtx({ f: '=A1*2', v: 10, m: '10' });
        warmFormulaCellInfoMap(ctx);

        ctx = applyPeerOps(ctx, ops);
        expect(ctx.sheets[0].data![5][1]?.f).toBe('=A6*2');
        [ctx] = edit(ctx, typed(5, 0, '4'));

        expect(ctx.sheets[0].data![5][1]?.v).toBe(8);
    });

    it('tracks the formulas on a sheet a peer added', () => {
        const ctx = makeCtx(null);
        warmFormulaCellInfoMap(ctx);
        const added = {
            name: 'third',
            id: 'id_3',
            order: 2,
            row: 4,
            column: 4,
            celldata: [
                { r: 0, c: 0, v: { v: 5, m: '5' } },
                { r: 0, c: 1, v: { f: '=A1*2', v: 10, m: '10' } },
            ],
            calcChain: [{ r: 0, c: 1, id: 'id_3' }],
        };

        const next = applyPeerOps(ctx, [{ op: 'addSheet', id: 'id_3', path: [], value: added }]);

        expect(next.formulaCache.formulaCellInfoMap![key(0, 1, 'id_3')]?.calc_funcStr).toBe('=A1*2');
    });
});
