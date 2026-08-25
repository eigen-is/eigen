// The per-edit recalc pipeline: reverse dependency index → affected closure →
// topological order → evaluate → groupValuesRefresh. These pin the behaviors
// the index rewrite must preserve: cross-sheet transitive recompute, index
// updates when formulas change, and rebuild-after-reset.

import { describe, expect, it } from 'bun:test';
import { enablePatches, produceWithPatches } from 'immer';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { setCellValue } from '../../../state/modules/cell';
import { setFormulaCellInfo } from '../../../state/modules/formula-cache';
import { execFunctionGroup, groupValuesRefresh, warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { contextFactory } from '../factories/context';

enablePatches();

function grid(rows: number, cols: number): (Cell | null)[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

// Two sheets: One!A1 = 5, One!B1 = =A1*2, Two!A1 = =One!B1+1
function makeCtx(): Context {
    const one = grid(4, 4);
    one[0][0] = { v: 5, m: '5' };
    one[0][1] = { f: '=A1*2', v: 10, m: '10' };
    const two = grid(4, 4);
    two[0][0] = { f: '=One!B1+1', v: 11, m: '11' };

    return contextFactory({
        currentSheetId: 'id_1',
        sheets: [
            { name: 'One', id: 'id_1', order: 0, data: one, calcChain: [{ r: 0, c: 1, id: 'id_1' }] },
            { name: 'Two', id: 'id_2', order: 1, data: two, calcChain: [{ r: 0, c: 0, id: 'id_2' }] },
        ],
    }) as Context;
}

function editCell(ctx: Context, r: number, c: number, value: number, id: string) {
    // Mirrors updateCell: recalc sees the new value via execFunctionGlobalData,
    // then the cell itself is written, then refresh applies dependent results.
    execFunctionGroup(ctx, r, c, value, id);
    const data = ctx.sheets[ctx.sheets.findIndex((s) => s.id === id)].data!;
    setCellValue(ctx, r, c, data, value);
    groupValuesRefresh(ctx);
}

describe('execFunctionGroup — index-driven recalc', () => {
    it('recomputes direct and cross-sheet transitive dependents in order', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14); // One!B1 = A1*2
        expect(ctx.sheets[1].data![0][0]?.v).toBe(15); // Two!A1 = One!B1+1
    });

    it('recomputes nothing when the edited cell has no dependents', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);

        execFunctionGroup(ctx, 3, 3, 42, 'id_1');

        expect(ctx.groupValuesRefreshData).toHaveLength(0);
    });

    it('builds the map and index lazily when not warmed', () => {
        const ctx = makeCtx();

        editCell(ctx, 0, 0, 3, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(6);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(7);
    });

    it('stops recomputing against a formula after it is rewritten to other deps', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);

        // One!B1 now depends on D1 instead of A1 (as updateCell would do:
        // rewrite the cell, then setFormulaCellInfo refreshes map + index).
        ctx.sheets[0].data![0][1] = { f: '=D1+1', v: 1, m: '1' };
        setFormulaCellInfo(ctx, { r: 0, c: 1, id: 'id_1' });

        editCell(ctx, 0, 0, 9, 'id_1');
        expect(ctx.sheets[0].data![0][1]?.v).toBe(1); // untouched

        editCell(ctx, 0, 3, 10, 'id_1'); // D1
        expect(ctx.sheets[0].data![0][1]?.v).toBe(11);
    });

    it('drops a deleted formula from the index', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);

        ctx.sheets[0].data![0][1] = null;
        setFormulaCellInfo(ctx, { r: 0, c: 1, id: 'id_1' });

        execFunctionGroup(ctx, 0, 0, 9, 'id_1');

        // Two!A1 still recomputes (it reads One!B1, now empty), but One!B1 must not.
        expect(ctx.groupValuesRefreshData.every((e) => !(e.r === 0 && e.c === 1 && e.id === 'id_1'))).toBe(true);
    });

    it('rebuilds map and index after a reset (row/col ops set the map to null)', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);
        editCell(ctx, 0, 0, 7, 'id_1');

        ctx.formulaCache.formulaCellInfoMap = null;

        editCell(ctx, 0, 0, 8, 'id_1');
        expect(ctx.sheets[0].data![0][1]?.v).toBe(16);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(17);
    });

    it('handles multi-cell edits via execFunctionExist', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);

        // Simulate a paste/delete that changed One!A1 and a cell nothing reads.
        ctx.sheets[0].data![0][0] = { v: 20, m: '20' };
        ctx.formulaCache.execFunctionExist = [
            { r: 0, c: 0, id: 'id_1' },
            { r: 2, c: 2, id: 'id_2' },
        ];
        execFunctionGroup(ctx, null, null, null, null);
        groupValuesRefresh(ctx);

        expect(ctx.sheets[0].data![0][1]?.v).toBe(40);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(41);
        expect(ctx.formulaCache.execFunctionExist).toBeUndefined();
    });

    it('produces identical results when run inside an immer draft', () => {
        const base = makeCtx();
        warmFormulaCellInfoMap(base);

        const [next] = produceWithPatches(base, (draft) => {
            editCell(draft as Context, 0, 0, 7, 'id_1');
        });

        expect(next.sheets[0].data![0][1]?.v).toBe(14);
        expect(next.sheets[1].data![0][0]?.v).toBe(15);
        // base untouched
        expect(base.sheets[0].data![0][1]?.v).toBe(10);
    });
});
