import { describe, expect, it, spyOn } from 'bun:test';
import type { Patch } from 'immer';
import { dependencySlots } from '../../../engine/dependency-index';
import { sheetFinder } from '../../../engine/parser/helper/cell';
import { extractDependencies } from '../../../engine/recalc';
import type { Cell, FormulaDependency } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { setFormulaCellInfo } from '../../../state/modules/formula-cache';
import { getcellrange, warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import type { Op } from '../../../state/types';
import { join, receive } from '../factories/collab';
import { contextFactory } from '../factories/context';
import { edit, pasteInternal, redo, sel, typed, undo } from '../factories/edit-cycle';

// A1 = 5, B1 = =A1*2, C1 = 3
function makeCtx(): Context {
    const data: (Cell | null)[][] = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = { f: '=A1*2', v: 10, m: '10' };
    data[0][2] = { v: 3, m: '3' };
    return contextFactory({
        currentSheetId: 'id_1',
        selections: sel(0, 0, 0, 0),
        sheets: [{ name: 'sheet', id: 'id_1', order: 0, data }],
    }) as Context;
}

const cell = (ctx: Context, r: number, c: number) => ctx.sheets[0].data![r][c];

// A paste replaces whole cells, so the history of its undo and redo carries whole-cell patches, and the map has to
// follow them either way.
// A peer's op or a file can write anything into a cell, and the formula map reads every `f` it finds.
describe('a formula that is no text', () => {
    const forged = [5, 0, true, {}, ''];

    it.each(forged)('a stored f of %p builds the map without it, and an edit still works', (f) => {
        const ctx = makeCtx();
        const data: unknown[][] = ctx.sheets[0].data ?? [];
        data[1][0] = { f, v: 1 };
        const map = warmFormulaCellInfoMap(ctx);
        expect(Object.keys(map)).toEqual(['r0c1iid_1']);
        const [next] = edit(ctx, typed(0, 0, '7'));
        expect(cell(next, 0, 1)?.v).toBe(14);
    });

    it.each(forged)('a peer writing an f of %p leaves the map as it was', (f) => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);
        const next = receive(ctx, [{ op: 'replace', id: 'id_1', path: ['data', 2, 0], value: { f, v: 1 } }]);
        expect(Object.keys(next.formulaCache.formulaCellInfoMap ?? {})).toEqual(['r0c1iid_1']);
        const stored: unknown = next.sheets[0].data?.[2][0];
        expect(stored).toEqual({ f, v: 1 });
    });

    it.each(forged)('an f of %p fails no rename or row op, on a tab or in the replay', (f) => {
        const ctx = makeCtx();
        const log: Op[][] = [
            [{ op: 'replace', id: 'id_1', path: ['data', 2, 0], value: { f, v: 1 } }],
            [{ op: 'renameSheet', id: 'id_1', path: [], value: { name: 'Renamed' } }],
            [
                {
                    op: 'insertRowCol',
                    id: 'id_1',
                    path: [],
                    value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
                },
            ],
        ];
        const live = log.reduce((next, ops) => receive(next, ops), ctx);
        expect(live.sheets[0].name).toBe('Renamed');
        expect(live.sheets[0].data?.[1][1]?.f).toBe('=A2*2');
        const [joined] = join(ctx, log);
        expect(joined.name).toBe('Renamed');
        expect(joined.celldata?.find(({ r, c }) => r === 1 && c === 1)?.v?.f).toBe('=A2*2');
    });

    it('a peer turning a formula into no text takes it out of the map', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);
        const next = receive(ctx, [{ op: 'replace', id: 'id_1', path: ['data', 0, 1, 'f'], value: 5 }]);
        expect(next.formulaCache.formulaCellInfoMap).toEqual({});
        expect(next.formulaCache.dependencyIndex.dependentsOf('id_1', 0, 0)).toEqual([]);
    });
});

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

    // Immer shrinks an array through its length, so only a peer's hand-made op drops a row this way.
    it('a batch that removes a row builds the map again', () => {
        const ctx = makeCtx();
        warmFormulaCellInfoMap(ctx);
        const patches: Patch[] = [{ op: 'remove', path: ['sheets', 0, 'data', 0] }];
        ctx.formulaCache.updateFormulaCache(ctx, { patches, inversePatches: [] }, 'redo');
        expect(ctx.formulaCache.formulaCellInfoMap).toBeNull();
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
        warmFormulaCellInfoMap(ctx);
        return ctx;
    };

    it('keeps the formula map it has, so a paste costs no rebuild', () => {
        const ctx = withWholeSums(makeCtx());
        const map = ctx.formulaCache.formulaCellInfoMap;
        const [pasted] = edit(ctx, pasteInternal([0, 2], [7, 7]));
        expect(pasted.sheets[0].data).toHaveLength(8);
        expect(pasted.formulaCache.formulaCellInfoMap).toBe(map);
    });

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
        const map = warmFormulaCellInfoMap(ctx);

        ctx = redo(ctx, history);
        expect(ctx.formulaCache.formulaCellInfoMap).toBe(map);
        [ctx] = edit(ctx, typed(7, 0, '100'));

        expect(cell(ctx, 0, 3)?.v).toBe(105);
    });
});

// A whole column of a tall sheet costs one entry, not one per block of 64 rows. Before that, 20,000 such lookups over
// 64,000 rows took three seconds and 490 MB to index.
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

        const [[, deps]] = set.mock.calls;
        expect(dependencySlots(deps)).toBe(2);
        expect(ctx.formulaCache.dependencyIndex.dependentsOf('d', 6_399, 0)).toEqual(['r0c1ir']);
    });
});

// The grid's UI shows a reference on the sheet as it is, so a whole column stops at the last row it holds.
describe('getcellrange', () => {
    const ctx = () =>
        contextFactory({
            currentSheetId: 's',
            sheets: [
                {
                    name: 'Sheet',
                    id: 's',
                    order: 0,
                    data: [
                        [null, null],
                        [null, null],
                        [null, null],
                    ],
                },
                { name: 'Empty', id: 'e', order: 1, data: [] },
                { name: 'Fresh', id: 'f', order: 2 },
            ],
        }) as Context;

    it('stops a whole column or row at its sheet, leaving a written end as it is', () => {
        expect(getcellrange(ctx(), 'A:B')).toEqual({ row: [0, 2], column: [0, 1], sheetId: 's' });
        expect(getcellrange(ctx(), '2:2')).toEqual({ row: [1, 1], column: [0, 1], sheetId: 's' });
        expect(getcellrange(ctx(), 'A1:C9')).toEqual({ row: [0, 8], column: [0, 2], sheetId: 's' });
    });

    it('covers nothing on a sheet with no rows, or on one with no matrix', () => {
        expect(getcellrange(ctx(), 'Empty!A:A')).toBeNull();
        expect(getcellrange(ctx(), 'Fresh!A1')).toBeNull();
    });
});

// A sheet nobody opened, such as a fresh copy, holds only its stored cells, and a formula that reads it must still be
// listed: it recalculates once the sheet is opened and edited.
describe('setFormulaCellInfo — a reference to a sheet with no matrix', () => {
    it('recomputes when the sheet is opened and edited', () => {
        const base = contextFactory({
            currentSheetId: 'r',
            selections: sel(0, 0, 0, 0),
            sheets: [
                { name: 'Report', id: 'r', order: 0, data: [[null, null]] },
                { name: 'Fresh', id: 'f', order: 1, celldata: [{ r: 0, c: 0, v: { v: 1 } }] },
            ],
        }) as Context;
        warmFormulaCellInfoMap(base);
        let [ctx] = edit(base, typed(0, 0, '=Fresh!A1+SUM(Fresh!B:B)'));

        [ctx] = edit(ctx, (draft) => {
            draft.sheets[1].data = [[{ v: 1 }, null]];
            draft.currentSheetId = 'f';
        });
        [ctx] = edit(ctx, typed(0, 0, '5'));
        [ctx] = edit(ctx, typed(0, 1, '7'));

        expect(ctx.sheets[0].data?.[0][0]?.v).toBe(12);
    });
});

// The editor's formula map and the server's recalc must find the same cells a formula reads, or an edit recalculates
// what an export would not. A whole column or row reads the same on any sheet, even Empty with no rows, and Holey,
// whose first row is missing, as a matrix from a stored file's rows can be. A function's arguments are read like any other part of the formula, INDEX, OFFSET and
// INDIRECT included.
describe('setFormulaCellInfo — the cells a formula reads', () => {
    const grid = (rows: number, cols: number): (Cell | null)[][] =>
        Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    const everyRow: [number, number] = [0, 1_048_575];
    const everyColumn: [number, number] = [0, 16_383];
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
        // The engine answers #VALUE! and reads nothing, so what is listed here can only cost a recompute.
        ['=SUM(Data!A1:Empty!B2)', [on('s2', [0, 1], [0, 1])]],
        ["=SUM('Data'!A1:'my sheet-1'!B2)", [on('s2', [0, 1], [0, 1])]],
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
        ['=SUM(A:A)', [on('s1', everyRow, [0, 0])]],
        ['=SUM(1:1)', [on('s1', [0, 0], everyColumn)]],
        ['=SUM(1:2)', [on('s1', [0, 1], everyColumn)]],
        // An end with no row spans every row and one with no column every column, as the engine reads it.
        ['=SUM(A:B1)', [on('s1', everyRow, [0, 1])]],
        ['=SUM(B2:1)', [on('s1', [0, 1], everyColumn)]],
        ['=SUM(A:1)', []],
        ['=SUM(Data!A:A)', [on('s2', everyRow, [0, 0])]],
        ['=SUM(Data!$B:$C)', [on('s2', everyRow, [1, 2])]],
        ['=SUM(Data!2:2)', [on('s2', [1, 1], everyColumn)]],
        ["=SUM('my sheet-1'!A:A)", [on('s3', everyRow, [0, 0])]],
        ['=SUM(Empty!1:1)+SUM(Empty!A:A)', [on('s5', [0, 0], everyColumn), on('s5', everyRow, [0, 0])]],
        ['=SUM(Empty!A1:B2)', [on('s5', [0, 1], [0, 1])]],
        ['=SUM(Holey!1:1)+A1', [on('s6', [0, 0], everyColumn), on('s1', [0, 0], [0, 0])]],
        ['=SUM(Holey!2:2)', [on('s6', [1, 1], everyColumn)]],
        ['=SUM(Holey!A:A)', [on('s6', everyRow, [0, 0])]],
        ['=$A$1+B$2+$C3', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1]), on('s1', [2, 2], [2, 2])]],
        ['=IF(A1>=1,C1,D1)', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [2, 2]), on('s1', [0, 0], [3, 3])]],
        ['=A1<>B1', [on('s1', [0, 0], [0, 0]), on('s1', [0, 0], [1, 1])]],
        ['=LOG10(A1)+ATAN2(B2,1)', [on('s1', [0, 0], [0, 0]), on('s1', [1, 1], [1, 1])]],
        // Excel reads the space as an intersection, so LOG10 is a cell. The engine answers #ERROR! and reads neither.
        ['=LOG10 (A1)', [on('s1', [9, 9], [8508, 8508]), on('s1', [0, 0], [0, 0])]],
        ['=SUM(A1 : B2)', [on('s1', [0, 1], [0, 1])]],
        ['=SUM(-1:2)', [on('s1', [0, 1], everyColumn)]],
        ["='a!b'!A1", [on('s7', [0, 0], [0, 0])]],
        ["=SUM('a!b'!A1:'a!b'!B2)", [on('s7', [0, 1], [0, 1])]],
        ['=T[(A1)]+B1', [on('s1', [0, 0], [1, 1])]],
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
                { name: 'a!b', id: 's7', order: 6, data: grid(2, 2) },
            ],
        }) as Context;
    // The cells the formula reads, through the editor's cache of resolved references.
    const reads = (ctx: Context, f: string) =>
        extractDependencies(
            {
                findSheet: sheetFinder(ctx.sheets),
                cellTextToIndexList: ctx.formulaCache.cellTextToIndexList,
            },
            f,
            's1',
        );

    it.each(cases)('%s', (f, cells) => {
        const ctx = workbook();
        expect(reads(ctx, f)).toEqual(cells);
        expect(extractDependencies({ findSheet: sheetFinder(ctx.sheets), cellTextToIndexList: {} }, f, 's1')).toEqual(
            cells,
        );
    });

    it('reads the same cells with the references it resolved kept from one formula to the next', () => {
        const ctx = workbook();
        for (const [f, cells] of cases) expect([f, reads(ctx, f)]).toEqual([f, cells]);
    });
});
