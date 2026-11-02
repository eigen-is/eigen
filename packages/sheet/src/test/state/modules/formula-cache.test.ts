// updateFormulaCache after undo/redo: a paste replaces whole cells, so the history carries
// whole-cell patches, and the map has to follow them either way.

import { describe, expect, it } from 'bun:test';
import { extractDependencies } from '../../../engine/recalc';
import type { Cell, FormulaDependency } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { setFormulaCellInfo } from '../../../state/modules/formula-cache';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { contextFactory } from '../factories/context';
import { edit, pasteInternal, redo, sel, typed, undo } from '../factories/edit-cycle';

// copy() writes the plain-text clipboard through document and sessionStorage.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = { createElement: () => ({ innerHTML: '', innerText: '', textContent: '' }) };
g.sessionStorage = { setItem: () => {} };

// A1 = 5, B1 = =A1*2, C1 = 3
function makeCtx(): Context {
    const data: (Cell | null)[][] = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = { f: '=A1*2', v: 10, m: '10' };
    data[0][2] = { v: 3, m: '3' };
    return contextFactory({
        currentSheetId: 'id_1',
        selections: sel(0, 0, 0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data, calcChain: [{ r: 0, c: 1, id: 'id_1' }] }],
    }) as Context;
}

const cell = (ctx: Context, r: number, c: number) => ctx.sheets[0].data![r][c];

describe('updateFormulaCache — whole-cell patches', () => {
    it('undoing a formula pasted over a value drops it from the map', () => {
        const base = makeCtx();
        warmFormulaCellInfoMap(base);
        const [pasted, history] = edit(base, pasteInternal([0, 1], [0, 2]));
        expect(cell(pasted, 0, 2)?.f).toBe('=B1*2');

        let ctx = undo(pasted, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.v).toBe(18);
        expect(cell(ctx, 0, 2)?.f).toBeUndefined();
        expect(cell(ctx, 0, 2)?.v).toBe(3);
    });

    it('redoing a value pasted over a formula drops it from the map', () => {
        const [pasted, history] = edit(makeCtx(), pasteInternal([0, 2], [0, 1]));
        let ctx = undo(pasted, history);
        expect(cell(ctx, 0, 1)?.f).toBe('=A1*2');

        ctx = redo(ctx, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.f).toBeUndefined();
        expect(cell(ctx, 0, 1)?.v).toBe(3);
    });

    it('undoing a value pasted over a formula puts it back in the map', () => {
        const [pasted, history] = edit(makeCtx(), pasteInternal([0, 2], [0, 1]));
        let ctx = undo(pasted, history);
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.v).toBe(18);
    });
});

// A paste past the last row appends whole rows, and their undo shrinks the matrix.
describe('updateFormulaCache — a paste that grows the grid', () => {
    it('undoing it drops the new rows from the map', () => {
        const base = makeCtx();
        warmFormulaCellInfoMap(base);
        const [pasted, history] = edit(base, pasteInternal([0, 1], [6, 1]));
        expect(cell(pasted, 6, 1)?.f).toBe('=A7*2');

        let ctx = undo(pasted, history);
        expect(ctx.formulaCache.formulaCellInfoMap?.r6c1iid_1).toBeUndefined();
        [ctx] = edit(ctx, typed(0, 0, '9'));

        expect(cell(ctx, 0, 1)?.v).toBe(18);
        expect(ctx.sheets[0].data).toHaveLength(6);
    });

    it("redoing it tracks the new rows' formulas", () => {
        const [pasted, history] = edit(makeCtx(), pasteInternal([0, 1], [6, 1]));
        let ctx = undo(pasted, history);
        ctx.formulaCache.formulaCellInfoMap = null;
        warmFormulaCellInfoMap(ctx);

        ctx = redo(ctx, history);
        [ctx] = edit(ctx, typed(6, 0, '4'));

        expect(cell(ctx, 6, 1)?.v).toBe(8);
    });
});

// A whole column of a tall sheet is indexed once per column, not once per block of 64 rows: before that, this map took
// three seconds and 490 MB to build.
describe('warmFormulaCellInfoMap — lookups into whole columns', () => {
    it('builds the map of 20,000 lookups over 64,000 rows in well under a second', () => {
        const data: (Cell | null)[][] = Array.from({ length: 64_000 }, (_, r) => [{ v: r }, { v: r * 2 }]);
        const report: (Cell | null)[][] = Array.from({ length: 20_000 }, (_, r) => [
            { v: r },
            { f: `=INDEX(Data!B:B,MATCH(A${r + 1},Data!A:A,0))` },
        ]);
        const ctx = contextFactory({
            currentSheetId: 'r',
            sheets: [
                { name: 'Data', id: 'd', order: 0, data },
                {
                    name: 'Report',
                    id: 'r',
                    order: 1,
                    data: report,
                    calcChain: report.map((_, r) => ({ r, c: 1, id: 'r' })),
                },
            ],
        }) as Context;

        const start = performance.now();
        warmFormulaCellInfoMap(ctx);
        expect(performance.now() - start).toBeLessThan(1_000);
        expect(ctx.formulaCache.dependencyIndex.dependentsOf('d', 63_999, 0)).toHaveLength(20_000);
    });
});

// The editor's formula map and the server's recalc must find the same cells a formula reads, or an edit recalculates
// what an export would not. Sheet1 is 6 × 4, so a whole column ends at row 6 and a whole row at column D. Data is
// 3 × 3, and Empty has no rows. A function's arguments are read like any other part of the formula, INDEX, OFFSET and
// INDIRECT included.
describe('setFormulaCellInfo — the cells a formula reads', () => {
    const grid = (rows: number, cols: number): (Cell | null)[][] =>
        Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    const on = (sheetId: string, [r0, r1]: [number, number], [c0, c1]: [number, number]): FormulaDependency => ({
        row: [r0, r1],
        column: [c0, c1],
        sheetId,
    });
    const cases: [string, FormulaDependency[]][] = [
        ['=A1+B2', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1])]],
        ['= A1 + B2', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1])]],
        ['=SUM( A1:B3 , Data!A1 )', [on('s1', [0, 2], [0, 1]), on('s2', [0, 0], [0, 0])]],
        ['=SUM(A1:B3)', [on('s1', [0, 2], [0, 1])]],
        ['=SUM(B3:A1)', [on('s1', [0, 2], [0, 1])]],
        ['=Data!B2*2', [on('s2', [1, 1], [1, 1])]],
        ['=SUM(Data!A1:B2)', [on('s2', [0, 1], [0, 1])]],
        ["='my sheet-1'!A1+1", [on('s3', [0, 0], [0, 0])]],
        ["='my sheet-1'!A1:B2", [on('s3', [0, 1], [0, 1])]],
        ["='it''s'!B1", [on('s4', [0, 0], [1, 1])]],
        ['="x"&B1&"y"', [on('s1', [0, 0], [1, 1])]],
        ['="""B1"""&C1', [on('s1', [0, 0], [2, 2])]],
        ['=A1="B2"', [on('s1', [0, 0], [0, 0])]],
        ['=""', []],
        ['=INDIRECT("B2")', []],
        ['=INDIRECT(A1)', [on('s1', [0, 0], [0, 0])]],
        ['=OFFSET(A1,0,0)', [on('s1', [0, 0], [0, 0])]],
        ['=OFFSET(A1,1,1)', [on('s1', [0, 0], [0, 0])]],
        ['=OFFSET(A1,1,B2)', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1])]],
        ['=INDEX(A1:B3,2,1)', [on('s1', [0, 2], [0, 1])]],
        ['=C1+INDEX(A1:B3,2,1)', [on('s1', [0, 0], [2, 2]), on('s1', [0, 2], [0, 1])]],
        ['=SUM(A1:INDEX(A1:B3,2,2))', [on('s1', [0, 0], [0, 0]), on('s1', [0, 2], [0, 1])]],
        ['=SUM(INDEX(A1:B3,1,1):B3)', [on('s1', [0, 2], [0, 1]), on('s1', [2, 2], [1, 1])]],
        ['=SUM(A:A)', [on('s1', [0, 5], [0, 0])]],
        ['=SUM(1:1)', [on('s1', [0, 0], [0, 3])]],
        ['=SUM(1:2)', [on('s1', [0, 1], [0, 3])]],
        ['=SUM(Data!A:A)', [on('s2', [0, 2], [0, 0])]],
        ['=SUM(Data!$B:$C)', [on('s2', [0, 2], [1, 2])]],
        ['=SUM(Data!2:2)', [on('s2', [1, 1], [0, 2])]],
        ["=SUM('my sheet-1'!A:A)", [on('s3', [0, 1], [0, 0])]],
        ['=SUM(Empty!1:1)+SUM(Empty!A:A)', []],
        ['=$A$1+B$2+$C3', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1]), on('s1', [2, 2], [2, 2])]],
        ['=IF(A1>=1,C1,D1)', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [2, 2]), on('s1', [0, 0], [3, 3])]],
        ['=A1<>B1', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [1, 1])]],
        ['=#REF!+A1', [on('s1', [0, 0], [0, 0])]],
        ['=Missing!A1+B1', [on('s1', [0, 0], [1, 1])]],
        ['=SUM(A1', [on('s1', [0, 0], [0, 0])]],
    ];

    it.each(cases)('%s', (f, reads) => {
        const sheet1 = grid(6, 4);
        sheet1[5][3] = { f };
        const ctx = contextFactory({
            currentSheetId: 's1',
            sheets: [
                { name: 'Sheet1', id: 's1', order: 0, data: sheet1 },
                { name: 'Data', id: 's2', order: 1, data: grid(3, 3) },
                { name: 'my sheet-1', id: 's3', order: 2, data: grid(2, 2) },
                { name: "it's", id: 's4', order: 3, data: grid(2, 2) },
                { name: 'Empty', id: 's5', order: 4, data: [] },
            ],
        }) as Context;

        setFormulaCellInfo(ctx, { r: 5, c: 3, id: 's1' });

        expect(ctx.formulaCache.formulaCellInfoMap?.r5c3is1?.formulaDependency).toEqual(reads);
        expect(extractDependencies({ sheets: ctx.sheets, cellTextToIndexList: {} }, f, 's1', sheet1)).toEqual(reads);
    });
});
