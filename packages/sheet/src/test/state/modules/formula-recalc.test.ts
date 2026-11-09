// The per-edit recalc pipeline: reverse dependency index → affected closure →
// topological order → evaluate → write. These pin the behaviors
// the index rewrite must preserve: cross-sheet transitive recompute, index
// updates when formulas change, and rebuild-after-reset.

import { describe, expect, it, spyOn } from 'bun:test';
import { enablePatches, isDraft, produceWithPatches } from 'immer';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import * as cellModule from '../../../state/modules/cell';
import { setFormulaCellInfo } from '../../../state/modules/formula-cache';
import { execFunctionGroup, getcellrange, warmFormulaGraph } from '../../../state/modules/formula-exec';
import { insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, deleteSheet, renameSheet } from '../../../state/modules/sheet';
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
            { name: 'One', id: 'id_1', order: 0, data: one },
            { name: 'Two', id: 'id_2', order: 1, data: two },
        ],
    }) as Context;
}

function editCell(ctx: Context, r: number, c: number, value: number, id: string) {
    const data = ctx.sheets[ctx.sheets.findIndex((s) => s.id === id)].data!;
    cellModule.setCellValue(ctx, r, c, data, value);
    execFunctionGroup(ctx, [{ r, c, id }]);
}

describe('execFunctionGroup — index-driven recalc', () => {
    it('recomputes direct and cross-sheet transitive dependents in order', () => {
        const ctx = makeCtx();
        warmFormulaGraph(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14); // One!B1 = A1*2
        expect(ctx.sheets[1].data![0][0]?.v).toBe(15); // Two!A1 = One!B1+1
    });

    it('recomputes nothing when the edited cell has no dependents', () => {
        const ctx = makeCtx();
        warmFormulaGraph(ctx);

        const data = ctx.sheets[0].data;
        const before = data![0][1];

        execFunctionGroup(ctx, [{ r: 3, c: 3, id: 'id_1' }]);

        expect(ctx.sheets[0].data).toBe(data);
        expect(ctx.sheets[0].data![0][1]).toBe(before);
    });

    it('builds the map and index lazily when not warmed', () => {
        const ctx = makeCtx();

        editCell(ctx, 0, 0, 3, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(6);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(7);
    });

    it('builds the whole map when a paste or delete registers its own cells first', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![3][3] = { f: '=1+1', v: 2, m: '2' };
        setFormulaCellInfo(ctx, { r: 3, c: 3, id: 'id_1' });

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(15);
    });

    it('builds the whole map right when the first recalc runs on another tab', () => {
        const ctx = makeCtx();

        // Search-and-replace recalcs a cell on Two while One is on screen.
        execFunctionGroup(ctx, [{ r: 3, c: 3, id: 'id_2' }]);
        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14);
    });

    it('builds the graph from a plain snapshot, not through the edit draft', () => {
        const base = makeCtx();
        const reads = spyOn(cellModule, 'getcellFormula');

        produceWithPatches(base, (draft) => {
            execFunctionGroup(draft as Context, [{ r: 0, c: 0, id: 'id_1' }]);
        });
        reads.mockRestore();

        expect(reads.mock.calls.filter(([ctx]) => isDraft(ctx))).toEqual([]);
        expect(base.formulaCache.graph?.formulaAt('id_1', 0, 1)?.formula).toBe('=A1*2');
    });

    it("builds the map from a plain matrix when handed the edit draft's", () => {
        const base = makeCtx();
        const reads = spyOn(cellModule, 'getcellFormula');
        let draftReads = -1;

        produceWithPatches(base, (draft) => {
            warmFormulaGraph(draft as Context);
            draftReads = reads.mock.calls.filter(([, , , , data]) => data != null && isDraft(data)).length;
        });
        reads.mockRestore();

        expect(draftReads).toBe(0);
    });

    it('stops recomputing against a formula after it is rewritten to other deps', () => {
        const ctx = makeCtx();
        warmFormulaGraph(ctx);

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
        warmFormulaGraph(ctx);

        ctx.sheets[0].data![0][1] = null;
        setFormulaCellInfo(ctx, { r: 0, c: 1, id: 'id_1' });

        execFunctionGroup(ctx, [{ r: 0, c: 0, id: 'id_1' }]);

        expect(ctx.sheets[0].data![0][1]).toBeNull();
    });

    it('rebuilds map and index after a reset (row/col ops set the map to null)', () => {
        const ctx = makeCtx();
        warmFormulaGraph(ctx);
        editCell(ctx, 0, 0, 7, 'id_1');

        ctx.formulaCache.forgetGraph();

        editCell(ctx, 0, 0, 8, 'id_1');
        expect(ctx.sheets[0].data![0][1]?.v).toBe(16);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(17);
    });

    it('handles a multi-cell edit', () => {
        const ctx = makeCtx();
        warmFormulaGraph(ctx);

        // Simulate a paste/delete that changed One!A1 and a cell nothing reads.
        ctx.sheets[0].data![0][0] = { v: 20, m: '20' };
        execFunctionGroup(ctx, [
            { r: 0, c: 0, id: 'id_1' },
            { r: 2, c: 2, id: 'id_2' },
        ]);

        expect(ctx.sheets[0].data![0][1]?.v).toBe(40);
        expect(ctx.sheets[1].data![0][0]?.v).toBe(41);
    });

    it('produces identical results when run inside an immer draft', () => {
        const base = makeCtx();
        warmFormulaGraph(base);

        const [next] = produceWithPatches(base, (draft) => {
            editCell(draft as Context, 0, 0, 7, 'id_1');
        });

        expect(next.sheets[0].data![0][1]?.v).toBe(14);
        expect(next.sheets[1].data![0][0]?.v).toBe(15);
        // base untouched
        expect(base.sheets[0].data![0][1]?.v).toBe(10);
    });

    it('recomputes a formula over a reversed range when a cell inside it changes', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][2] = { f: '=SUM(A3:A1)', v: 5, m: '5' };
        ctx.sheets[0].data![1][3] = { f: '=SUM(B$3:A1)', v: 15, m: '15' };
        warmFormulaGraph(ctx);

        cellModule.updateCell(ctx, 1, 0, null, 7);

        expect(ctx.sheets[0].data![0][2]?.v).toBe(12);
        expect(ctx.sheets[0].data![1][3]?.v).toBe(22);
    });

    // An imported cell holds the value Excel computed. Once an input changes, IFERROR's fallback around a function
    // the engine lacks would read as a real answer, and a #NAME? would destroy the number, so the number stays.
    it('keeps the number of a real Excel function the engine lacks, even inside IFERROR, once an input changes', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][2] = { f: '=IFERROR(FILTER(A1:A3,A1:A3>1),"none")', v: 5, m: '5' };
        warmFormulaGraph(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][2]?.v).toBe(5);
    });

    it('gives the fallback for a name Excel does not know either, such as a typo, as in Excel', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][2] = { f: '=IFERROR(FILTRE(A1),"x")', v: 'x', m: 'x' };
        ctx.sheets[0].data![0][3] = { f: '=IFERROR(FILTRE(A1),A1)', v: 5, m: '5' };
        warmFormulaGraph(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][2]?.v).toBe('x');
        expect(ctx.sheets[0].data![0][3]?.v).toBe(7);
    });

    it('an error a formula computes is one to the formulas that read it, on its sheet and another', () => {
        const ctx = makeCtx();
        const one = ctx.sheets[0].data!;
        one[0][2] = { f: '=1/(A1-7)', v: -0.5, m: '-0.5' };
        one[0][3] = { f: '=IFERROR(C1,"none")', v: -0.5, m: '-0.5' };
        one[1][0] = { f: '=ISERROR(C1)', v: false, m: 'FALSE' };
        one[1][1] = { f: '=C1+1', v: 0.5, m: '0.5' };
        ctx.sheets[1].data![1][0] = { f: '=ERROR.TYPE(One!C1)', v: '#N/A', m: '#N/A' };
        warmFormulaGraph(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect([one[0][2]?.v, one[0][3]?.v, one[1][0]?.v, one[1][1]?.v]).toEqual(['#DIV/0!', 'none', true, '#DIV/0!']);
        expect(ctx.sheets[1].data![1][0]?.v).toBe(2);
    });

    // The FILTER cell's #NAME? stands in for a value Excel computed, so IFERROR one cell away hands it on too.
    it('a #NAME? one cell away from a function the engine lacks is no error IFERROR traps', () => {
        const ctx = makeCtx();
        ctx.sheets[0].data![0][2] = { f: '=FILTER(A1:A3,A1:A3>1)' };
        ctx.sheets[0].data![0][3] = { f: '=IFERROR(C1,"none")', v: 5, m: '5' };
        warmFormulaGraph(ctx);

        editCell(ctx, 0, 0, 7, 'id_1');

        expect(ctx.sheets[0].data![0][3]?.v).toBe('#NAME?');
    });
});

// A function's arguments are inputs like any other part of the formula, so INDEX's range and OFFSET's reference
// recompute their cell, and so does a whole column or row on the formula's sheet or another. The engine has no OFFSET,
// and reads no range that ends on a call, so those two cells show the engine's error once an input changes. A space
// around a reference, as a person types one, changes nothing.
describe('updateCell — the formulas that read an edited cell through a function, a whole column or a space', () => {
    const num = (v: number): Cell => ({ v, m: String(v) });

    it('recomputes each of them', () => {
        const sheet1 = grid(6, 4);
        sheet1[0][0] = num(1);
        sheet1[0][1] = num(2);
        sheet1[1][0] = num(3);
        sheet1[1][1] = num(4);
        sheet1[2][0] = num(5);
        sheet1[2][1] = num(6);
        const formulas: [number, number, string, number][] = [
            [0, 3, '=INDEX(A1:B3,1,1)', 1],
            [1, 3, '=SUM(A:A)', 9],
            [2, 3, '=OFFSET(A1,0,0)', 1],
            [3, 3, '=SUM(A1:INDEX(A1:B3,2,2))', 10],
            [4, 3, '=SUM(1:1)', 4],
            [5, 3, '=SUM(Data!A:A)', 6],
            [5, 2, '=SUM(Data!1:1)', 1],
            [0, 2, '=A1 + 1', 2],
        ];
        for (const [r, c, f, v] of formulas) sheet1[r][c] = { f, v, m: String(v) };
        const data = grid(3, 3);
        data[0][0] = num(1);
        data[1][0] = num(2);
        data[2][0] = num(3);
        const ctx = contextFactory({
            currentSheetId: 's1',
            sheets: [
                {
                    name: 'Sheet1',
                    id: 's1',
                    order: 0,
                    data: sheet1,
                },
                { name: 'Data', id: 's2', order: 1, data },
            ],
        }) as Context;
        warmFormulaGraph(ctx);
        const shown = () => formulas.map(([r, c]) => ctx.sheets[0].data![r][c]?.m);

        cellModule.updateCell(ctx, 0, 0, null, 10);
        expect(shown()).toEqual(['10', '18', '1', '10', '33', '6', '1', '11']);

        ctx.currentSheetId = 's2';
        cellModule.updateCell(ctx, 0, 0, null, 10);
        expect(shown()).toEqual(['10', '18', '1', '10', '33', '15', '10', '11']);
    });
});

// The editor keeps each reference it resolved, by its text, from one edit to the next. A change to the sheets must
// drop them: a whole column ends where its sheet ended when it was resolved, and a sheet name names the sheet that had
// it then.
describe('execFunctionGroup — references resolved before the sheets changed', () => {
    // One!A1 = 1, and B1 of One or Two holds the formula, if there is one.
    function workbook(formula?: string, id = 'id_2'): Context {
        const one = grid(4, 4);
        one[0][0] = { v: 1, m: '1' };
        const two = grid(4, 4);
        if (formula != null) (id === 'id_1' ? one : two)[0][1] = { f: formula, v: 1, m: '1' };
        return contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                { name: 'One', id: 'id_1', order: 0, data: one },
                { name: 'Two', id: 'id_2', order: 1, data: two },
            ].map((sheet) => ({
                ...sheet,
            })),
        }) as Context;
    }
    const growOne = (ctx: Context) =>
        insertRowCol(ctx, { type: 'row', index: 3, count: 4, direction: 'rightbottom', id: 'id_1' });

    it('a whole column on another sheet reads the rows an insert added', () => {
        const ctx = workbook('=SUM(One!A:A)');
        warmFormulaGraph(ctx);
        growOne(ctx);
        editCell(ctx, 6, 0, 5, 'id_1');
        expect(ctx.sheets[1].data?.[0][1]?.v).toBe(6);
    });

    it('a whole column on its own sheet reads the rows an insert added', () => {
        const ctx = workbook('=SUM(A:A)', 'id_1');
        warmFormulaGraph(ctx);
        growOne(ctx);
        editCell(ctx, 6, 0, 5, 'id_1');
        expect(ctx.sheets[0].data?.[0][1]?.v).toBe(6);
    });

    it('a sheet added under a deleted name does not heal what the delete broke', () => {
        const ctx = workbook('=One!A1');
        warmFormulaGraph(ctx);
        deleteSheet(ctx, 'id_1');
        addSheet(ctx, 'id_3', 'One');
        ctx.sheets[1].data = grid(4, 4);
        editCell(ctx, 0, 0, 100, 'id_3');
        expect(ctx.sheets[0].data?.[0][1]?.f).toBe('=#REF!');
        expect(ctx.sheets[0].data?.[0][1]?.v).toBe('#REF!');
    });

    it('a sheet name that read no sheet reads the sheet renamed to it', () => {
        const ctx = workbook('=Old!A1');
        warmFormulaGraph(ctx);
        renameSheet(ctx, { id: 'id_1', name: 'Old' });
        editCell(ctx, 0, 0, 7, 'id_1');
        expect(ctx.sheets[1].data?.[0][1]?.v).toBe(7);
    });

    // A rename points the formula at the new name, so the formula keeps reading the sheet.
    it('a formula that names a renamed sheet follows it, and the graph knows', () => {
        const ctx = workbook('=One!A1');
        warmFormulaGraph(ctx);
        getcellrange(ctx, 'One!A1');
        renameSheet(ctx, { id: 'id_1', name: 'Gone' });
        expect(ctx.sheets[1].data?.[0][1]?.f).toBe('=Gone!A1');
        const graph = warmFormulaGraph(ctx);
        expect(graph.formulaAt('id_2', 0, 1)?.formula).toBe('=Gone!A1');
        expect(graph.affected(ctx.sheets, [{ id: 'id_1', r: 0, c: 0 }])).toMatchObject([{ id: 'id_2', r: 0, c: 1 }]);
    });

    it('a sheet name another caller resolved reads no sheet once a peer renames it, before the map is built', () => {
        const ctx = workbook();
        expect(getcellrange(ctx, 'One!A1')?.sheetId).toBe('id_1');
        renameSheet(ctx, { id: 'id_1', name: 'Gone' });
        expect(getcellrange(ctx, 'One!A1')).toBeNull();
    });

    // A replay of the op log hands the engine sheets whose names may differ from the ones it knew.
    it('a sheet name another caller resolved reads no sheet once a peer renames it, after a replay', () => {
        const ctx = workbook('=One!A1');
        warmFormulaGraph(ctx);
        ctx.formulaCache.resetEngine();
        ctx.sheets[0].name = 'Old';
        getcellrange(ctx, 'Old!A1');
        renameSheet(ctx, { id: 'id_1', name: 'One' });
        expect(getcellrange(ctx, 'Old!A1')).toBeNull();
    });
});
