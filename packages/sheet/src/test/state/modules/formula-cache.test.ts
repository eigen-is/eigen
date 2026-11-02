import { describe, expect, it, spyOn } from 'bun:test';
import { dependencySlots } from '../../../engine/dependency-index';
import { extractDependencies } from '../../../engine/recalc';
import type { Cell, FormulaDependency } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { setFormulaCellInfo } from '../../../state/modules/formula-cache';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import { insertRowCol } from '../../../state/modules/rowcol';
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

// A paste replaces whole cells, so the history of its undo and redo carries whole-cell patches, and the map has to
// follow them either way.
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

    // D1 = SUM(A:A) and F2 = SUM(1:1), on the 6 × 6 grid. Pasting C1 into H8 grows it to 8 × 8.
    const withWholeSums = (ctx: Context) => {
        const data = ctx.sheets[0].data ?? [];
        data[0][3] = { f: '=SUM(A:A)', v: 5, m: '5' };
        data[1][5] = { f: '=SUM(1:1)', v: 23, m: '23' };
        ctx.sheets[0].calcChain?.push({ r: 0, c: 3, id: 'id_1' }, { r: 1, c: 5, id: 'id_1' });
        warmFormulaCellInfoMap(ctx);
        return ctx;
    };

    it('a whole column reads the rows it added, and a whole row the columns', () => {
        let [ctx] = edit(withWholeSums(makeCtx()), pasteInternal([0, 2], [7, 7]));
        [ctx] = edit(ctx, typed(7, 0, '100'));
        [ctx] = edit(ctx, typed(0, 7, '1000'));

        expect(cell(ctx, 0, 3)?.v).toBe(105);
        expect(cell(ctx, 1, 5)?.v).toBe(5 + 10 + 3 + 105 + 1000);
    });

    it('redoing it, as a peer applies it, extends a whole column', () => {
        const [pasted, history] = edit(withWholeSums(makeCtx()), pasteInternal([0, 2], [7, 7]));
        let ctx = undo(pasted, history);
        warmFormulaCellInfoMap(ctx);

        ctx = redo(ctx, history);
        [ctx] = edit(ctx, typed(7, 0, '100'));

        expect(cell(ctx, 0, 3)?.v).toBe(105);
    });
});

// The editor hands the dependency index each sheet's size, so a whole column of a tall sheet costs one entry, not one
// per block of 64 rows. Before that, 20,000 such lookups over 64,000 rows took three seconds and 490 MB to index.
describe('setFormulaCellInfo — lookups into whole columns', () => {
    it('indexes each whole column once', () => {
        const data: (Cell | null)[][] = Array.from({ length: 6_400 }, (_, r) => [{ v: r }, { v: r * 2 }]);
        const ctx = contextFactory({
            currentSheetId: 'r',
            sheets: [
                { name: 'Data', id: 'd', order: 0, data },
                {
                    name: 'Report',
                    id: 'r',
                    order: 1,
                    data: [[{ v: 5 }, { f: '=INDEX(Data!B:B,MATCH(A1,Data!A:A,0))' }]],
                },
            ],
        }) as Context;
        warmFormulaCellInfoMap(ctx);
        const set = spyOn(ctx.formulaCache.dependencyIndex, 'set');

        setFormulaCellInfo(ctx, { r: 0, c: 1, id: 'r' });

        const [[, deps, extentOf]] = set.mock.calls;
        expect(extentOf('d')).toEqual({ rows: 6_400, columns: 2 });
        expect(dependencySlots(deps, extentOf)).toBe(2);
        expect(ctx.formulaCache.dependencyIndex.dependentsOf('d', 6_399, 0)).toEqual(['r0c1ir']);
    });

    // A stored matrix may lack rows, its first among them.
    it('measures a sheet by its widest row', () => {
        const ctx = contextFactory({
            currentSheetId: 'r',
            sheets: [
                { name: 'Holey', id: 'h', order: 0, data: JSON.parse('[null, [null, null]]') },
                { name: 'Report', id: 'r', order: 1, data: [[{ f: '=SUM(Holey!1:2)' }]] },
            ],
        }) as Context;
        warmFormulaCellInfoMap(ctx);
        const set = spyOn(ctx.formulaCache.dependencyIndex, 'set');

        setFormulaCellInfo(ctx, { r: 0, c: 0, id: 'r' });

        const [[, , extentOf]] = set.mock.calls;
        expect(extentOf('h')).toEqual({ rows: 2, columns: 2 });
    });
});

// The editor's formula map and the server's recalc must find the same cells a formula reads, or an edit recalculates
// what an export would not. Sheet1 is 6 × 4, so a whole column ends at row 6 and a whole row at column D. Data is
// 3 × 3, and Empty has no rows. Holey's first row is missing, as a matrix from a stored file's rows can be, so its
// width is its second row's. A function's arguments are read like any other part of the formula, INDEX, OFFSET and
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
        ['=data!B2*2', [on('s2', [1, 1], [1, 1])]],
        ["=SUM('DATA'!A1:data!B2)", [on('s2', [0, 1], [0, 1])]],
        ['=SUM(Data!A1:B2)', [on('s2', [0, 1], [0, 1])]],
        ['=SUM(Data!A1:Data!B2)', [on('s2', [0, 1], [0, 1])]],
        ["=SUM('Data'!A1:'Data'!B2)", [on('s2', [0, 1], [0, 1])]],
        ["=SUM(Data!A1:'Data'!B2)", [on('s2', [0, 1], [0, 1])]],
        ["=SUM('Data'!A1:Data!B2)", [on('s2', [0, 1], [0, 1])]],
        ["=SUM('my sheet-1'!A1:'my sheet-1'!B2)", [on('s3', [0, 1], [0, 1])]],
        ['=SUM(Data!A1:Empty!B2)', []],
        ["=SUM('Data'!A1:'my sheet-1'!B2)", []],
        ['=SUM(A1:Data!B2)', []],
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
        ['=SUM(Empty!A1:B2)', [on('s5', [0, 1], [0, 1])]],
        ['=SUM(Holey!1:1)+A1', [on('s6', [0, 0], [0, 1]), on('s1', [0, 0], [0, 0])]],
        ['=SUM(Holey!2:2)', [on('s6', [1, 1], [0, 1])]],
        ['=SUM(Holey!A:A)', [on('s6', [0, 1], [0, 0])]],
        ['=$A$1+B$2+$C3', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1]), on('s1', [2, 2], [2, 2])]],
        ['=IF(A1>=1,C1,D1)', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [2, 2]), on('s1', [0, 0], [3, 3])]],
        ['=A1<>B1', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [1, 1])]],
        ['=LOG10(A1)+ATAN2(B2,1)', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1])]],
        ['=LOG10 (A1)', [on('s1', [0, 0], [0, 0])]],
        ['=A1==B1', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [1, 1])]],
        ['=#REF!+A1', [on('s1', [0, 0], [0, 0])]],
        ['=Missing!A1+B1', [on('s1', [0, 0], [1, 1])]],
        ['=SUM(A1', [on('s1', [0, 0], [0, 0])]],
    ];

    const workbook = () =>
        contextFactory({
            currentSheetId: 's1',
            sheets: [
                { name: 'Sheet1', id: 's1', order: 0, data: grid(6, 4) },
                { name: 'Data', id: 's2', order: 1, data: grid(3, 3) },
                { name: 'my sheet-1', id: 's3', order: 2, data: grid(2, 2) },
                { name: "it's", id: 's4', order: 3, data: grid(2, 2) },
                { name: 'Empty', id: 's5', order: 4, data: [] },
                { name: 'Holey', id: 's6', order: 5, data: JSON.parse('[null, [null, null]]') },
            ],
        }) as Context;
    // Types the formula into D6 and returns the cells the formula map says it reads.
    const reads = (ctx: Context, f: string) => {
        const sheet1 = ctx.sheets[0].data ?? [];
        sheet1[5][3] = { f };
        setFormulaCellInfo(ctx, { r: 5, c: 3, id: 's1' });
        return ctx.formulaCache.formulaCellInfoMap?.r5c3is1?.formulaDependency;
    };

    it.each(cases)('%s', (f, cells) => {
        const ctx = workbook();
        expect(reads(ctx, f)).toEqual(cells);
        expect(
            extractDependencies({ sheets: ctx.sheets, cellTextToIndexList: {} }, f, 's1', ctx.sheets[0].data),
        ).toEqual(cells);
    });

    it('reads the same cells with the references it resolved kept from one formula to the next', () => {
        const ctx = workbook();
        for (const [f, cells] of cases) expect([f, reads(ctx, f)]).toEqual([f, cells]);
    });

    it('reads a whole column or row to the end of its grown sheet', () => {
        const ctx = workbook();
        const f = '=SUM(A:A)+SUM(Data!2:2)';
        expect(reads(ctx, f)).toEqual([on('s1', [0, 5], [0, 0]), on('s2', [1, 1], [0, 2])]);
        insertRowCol(ctx, { type: 'row', index: 5, count: 2, direction: 'rightbottom', id: 's1' });
        insertRowCol(ctx, { type: 'column', index: 2, count: 1, direction: 'rightbottom', id: 's2' });
        expect(reads(ctx, f)).toEqual([on('s1', [0, 7], [0, 0]), on('s2', [1, 1], [0, 3])]);
    });
});
