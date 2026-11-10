// applyOp keeps the formula dependency map in step with a peer's cell edits: the map counts
// as built once it exists, so a formula that arrives over the wire is only tracked if
// applyOp registers it.

import { describe, expect, it } from 'bun:test';
import type { Sheet as LibSheet } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { dataToCelldata } from '../../../engine/celldata';
import { MAX_SHEET_ROW_COUNT } from '../../../engine/defaults';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { changeSheet } from '../../../state/modules/sheet';
import type { Op } from '../../../state/types';
import { emitOps, join } from '../../state/factories/collab';
import { heldGraph, workbookContextFactory } from '../../state/factories/context';
import { edit, pasteInternal, sel, typed } from '../../state/factories/edit-cycle';

// A1 = 5, B1 = b1.
function makeData(b1: Cell | null, rows = 4): (Cell | null)[][] {
    const data: (Cell | null)[][] = Array.from({ length: rows }, () => Array.from({ length: 4 }, () => null));
    data[0][0] = { v: 5, m: '5' };
    data[0][1] = b1;
    return data;
}

function makeCtx(b1: Cell | null, currentSheetId = 'id_1'): Context {
    const data = makeData(b1);
    return workbookContextFactory({
        currentSheetId,
        selections: sel(0, 0, 0, 0),
        sheets: [
            {
                name: 'first',
                id: 'id_1',
                order: 0,
                row: 4,
                column: 4,
                data,
            },
            { name: 'second', id: 'id_2', order: 1, row: 4, column: 4, data: makeData(null) },
        ],
    });
}

function applyPeerOps(ctx: Context, ops: Op[]): Context {
    let next = ctx;
    const setContext = (recipe: (draft: Context) => void) => {
        next = produce(next, recipe);
    };
    generateAPIs(
        () => next,
        setContext,
        () => {},
        () => {},
        { undoList: [], redoList: [] },
    ).applyOp(ops);
    return next;
}

// The peer types `value` into B1 on its own copy; the local client, map already built, applies the ops.
function receivePeerEdit(b1: Cell | null, value: string, warm = true): Context {
    const ops = emitOps(makeCtx(b1), typed(0, 1, value));
    const ctx = makeCtx(b1);
    if (warm) heldGraph(ctx);
    return applyPeerOps(ctx, ops);
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

    it('leaves an unbuilt map for its first use to build, peer formula included', () => {
        let ctx = receivePeerEdit(null, '=A1*2', false);
        expect(ctx.formulaCache.graph).toBeNull();

        [ctx] = edit(ctx, typed(0, 0, '7'));

        expect(ctx.sheets[0].data![0][1]?.v).toBe(14);
    });

    it("registers a peer's formula on a sheet other than the current one", () => {
        const ops = emitOps(makeCtx(null, 'id_2'), typed(0, 1, '=A1*2'));
        const ctx = makeCtx(null);
        heldGraph(ctx);

        const next = applyPeerOps(ctx, ops);

        const graph = next.formulaCache.graph;
        expect(graph?.formulaAt('id_2', 0, 1)?.formula).toBe('=A1*2');
        expect(graph?.formulaAt('id_1', 0, 1)).toBeUndefined();
    });

    it('re-registers only the cell a peer typed over', () => {
        const withColumn = (ctx: Context) => {
            const data = makeData({ f: '=A1*2', v: 10, m: '10' }, 50);
            for (let r = 1; r < 50; r += 1) data[r][1] = { f: `=A${r + 1}*2`, v: 0, m: '0' };
            ctx.sheets[0].data = data;
            return ctx;
        };
        const ops = emitOps(withColumn(makeCtx(null)), typed(0, 1, '3'));
        const ctx = withColumn(makeCtx(null));
        const before = heldGraph(ctx);
        const kept = Array.from({ length: 50 }, (_, r) => before.formulaAt('id_1', r, 1));

        const graph = applyPeerOps(ctx, ops).formulaCache.graph;

        expect(graph?.formulaAt('id_1', 0, 1)).toBeUndefined();
        for (let r = 1; r < 50; r += 1) expect(graph?.formulaAt('id_1', r, 1)).toBe(kept[r]);
    });

    it("tracks the formulas in rows a peer's paste appended", () => {
        const ops = emitOps(makeCtx({ f: '=A1*2', v: 10, m: '10' }), pasteInternal([0, 1], [5, 1]));
        let ctx = makeCtx({ f: '=A1*2', v: 10, m: '10' });
        heldGraph(ctx);

        ctx = applyPeerOps(ctx, ops);
        expect(ctx.sheets[0].data![5][1]?.f).toBe('=A6*2');
        [ctx] = edit(ctx, typed(5, 0, '4'));

        expect(ctx.sheets[0].data![5][1]?.v).toBe(8);
    });

    it('tracks the formulas on a sheet a peer added', () => {
        const ctx = makeCtx(null);
        heldGraph(ctx);
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
        };

        const next = applyPeerOps(ctx, [{ op: 'addSheet', id: 'id_3', path: [], value: added }]);

        expect(heldGraph(next).formulaAt('id_3', 0, 1)?.formula).toBe('=A1*2');
    });
});

// replaySheetsOps rolls a failing batch back whole, so a live client must too or it disagrees with a joiner.
describe('applyOp and a batch that fails halfway', () => {
    const ops: Op[] = [
        { op: 'deleteRowCol', id: 'id_1', path: [], value: { type: 'row', start: 3, end: 3, id: 'id_1' } },
        { op: 'replace', id: 'id_1', path: ['data', 0, 0], value: { v: 9, m: '9' } },
        { op: 'replace', id: 'id_1', path: ['data', 9, 9, 'v'], value: 1 },
    ];

    it('applies none of it, a row delete before the failing patch included, as the replay does', () => {
        const ctx = makeCtx(null);
        const peer = applyPeerOps(ctx, ops);
        const [joiner] = join(ctx, [ops]);
        expect(peer.sheets[0].data).toEqual(ctx.sheets[0].data);
        expect(joiner.celldata).toEqual(dataToCelldata(ctx.sheets[0].data));
    });

    it('says the batch did not apply, and that a good one did', () => {
        let next = makeCtx(null);
        const setContext = (recipe: (draft: Context) => void) => {
            next = produce(next, recipe);
        };
        const workbook = generateAPIs(
            () => next,
            setContext,
            () => {},
            () => {},
            { undoList: [], redoList: [] },
        );
        expect(workbook.applyOp(ops)).toBe(false);
        expect(workbook.applyOp(ops.slice(0, 2))).toBe(true);
    });
});

// A live client applies a batch to the same sheets a joiner's replay builds from it.
describe('applyOp and a joiner agree on the batch shapes that once disagreed', () => {
    const summary = (sheets: { id?: string; name: string; order?: number; color?: string }[]) =>
        sheets.map(({ id, name, order, color }) => ({ id, name, order, color }));
    const added = { name: 'third', id: 'id_3', order: 2, row: 4, column: 4, celldata: [] };

    it('applies an op on a sheet the same batch adds', () => {
        const ops: Op[] = [
            { op: 'addSheet', id: 'id_3', path: [], value: structuredClone(added) },
            { op: 'replace', id: 'id_3', path: ['color'], value: '#ff0000' },
        ];
        const ctx = makeCtx(null);
        expect(summary(join(ctx, [ops]))[2].color).toBe('#ff0000');
        expect(summary(applyPeerOps(ctx, ops).sheets)).toEqual(summary(join(ctx, [ops])));
    });

    it('keeps the order ops of a batch that deletes a sheet', () => {
        const ops: Op[] = [
            { op: 'deleteSheet', id: 'id_1', path: [], value: { id: 'id_1' } },
            { op: 'replace', id: 'id_2', path: ['order'], value: 5 },
        ];
        const ctx = makeCtx(null);
        expect(summary(applyPeerOps(ctx, ops).sheets)).toEqual(summary(join(ctx, [ops])));
    });

    it('leaves the formula graph alone when a batch fails after adding a sheet with formulas', () => {
        const withFormula = {
            ...added,
            celldata: [
                { r: 0, c: 0, v: { v: 5, m: '5' } },
                { r: 0, c: 1, v: { f: '=A1*2', v: 10, m: '10' } },
            ],
        };
        const ops: Op[] = [
            { op: 'addSheet', id: 'id_3', path: [], value: withFormula },
            { op: 'replace', id: 'id_1', path: ['data', 9, 9, 'v'], value: 1 },
        ];
        const ctx = makeCtx(null);
        const before = { ...heldGraph(ctx).formulas };
        const next = applyPeerOps(ctx, ops);
        expect(summary(next.sheets)).toEqual(summary(join(ctx, [ops])));
        expect({ ...heldGraph(next).formulas }).toEqual(before);
    });

    it("inserts on the op's own sheet, as the replay does, whatever sheet is current", () => {
        const ops: Op[] = [
            {
                op: 'insertRowCol',
                id: 'id_2',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ];
        const ctx = makeCtx({ v: 1, m: '1' });
        const next = applyPeerOps(ctx, ops);
        expect(next.sheets.map((s) => s.data?.length)).toEqual([4, 5]);
        expect(join(ctx, [ops])[1].data?.length).toBe(5);
    });

    it('skips the whole batch of an insert past the row limit, as the replay does', () => {
        const ops: Op[] = [
            {
                op: 'insertRowCol',
                id: 'id_1',
                path: [],
                value: { type: 'row', index: 1, count: 1, direction: 'lefttop' },
            },
            { op: 'replace', id: 'id_1', path: ['data', 0, 0], value: { v: 9, m: '9' } },
        ];
        const ctx = produce(makeCtx(null), (draft: Context) => {
            const width = draft.sheets[0].data?.[0]?.length ?? 1;
            while ((draft.sheets[0].data?.length ?? MAX_SHEET_ROW_COUNT) < MAX_SHEET_ROW_COUNT) {
                draft.sheets[0].data?.push(new Array(width).fill(null));
            }
            draft.sheets[0].row = MAX_SHEET_ROW_COUNT;
        });
        const [joiner] = join(ctx, [ops]);
        const [live] = applyPeerOps(ctx, ops).sheets;
        expect(live.data && dataToCelldata(live.data)).toEqual(joiner.celldata);
        expect(joiner.celldata?.find(({ r, c }) => r === 0 && c === 0)?.v?.v).toBe(5);
    });
});

// The replay skips a sheet add whose value has the wrong shape and applies the rest of the batch, and skips the whole
// batch of a row op with one. A live client must do the same, or it keeps a row or a sheet that every joiner, and the
// compacted log, lacks. The sheet adds it does take must end with the same cells on both paths.
describe('applyOp and a joiner skip the same malformed sheet and row ops', () => {
    const grid = (sheets: Pick<LibSheet, 'id' | 'name' | 'data' | 'celldata' | 'row' | 'column'>[]) =>
        sheets.map((s) => ({
            id: s.id,
            name: s.name,
            rows: s.data?.length ?? s.row,
            columns: s.data?.[0]?.length ?? s.column,
            cells: s.data ? dataToCelldata(s.data) : s.celldata,
        }));
    const typedA1: Op = { op: 'replace', id: 'id_1', path: ['data', 0, 0], value: { v: 9, m: '9' } };
    const insert = (value: unknown): Op => ({ op: 'insertRowCol', id: 'id_1', path: [], value });
    const remove = (value: unknown): Op => ({ op: 'deleteRowCol', id: 'id_1', path: [], value });
    const add = (value: unknown): Op => ({ op: 'addSheet', path: [], value });

    it.each([
        ['a row insert without a direction', insert({ type: 'row', index: 1, count: 1 })],
        ['a row insert with a text count', insert({ type: 'row', index: 1, count: '1', direction: 'lefttop' })],
        ['an insert of an unknown kind', insert({ type: 'rows', index: 1, count: 1, direction: 'lefttop' })],
        ['an insert without a value', insert(undefined)],
        ['a row delete with a text start', remove({ type: 'row', start: '1', end: 1 })],
        ['a delete of an unknown kind', remove({ type: 'rows', start: 1, end: 1 })],
        ['a sheet add without a name', add({ id: 'id_3', order: 2, row: 4, column: 4, celldata: [] })],
        ['a sheet add with a numeric id', add({ id: 3, name: 'third', order: 2, row: 4, column: 4, celldata: [] })],
        ['a sheet add with an empty id', add({ id: '', name: 'third', order: 2, row: 4, column: 4, celldata: [] })],
    ])('%s', (_, op) => {
        const ctx = makeCtx(null);
        const ops = [op, typedA1];
        expect(grid(applyPeerOps(ctx, ops).sheets)).toEqual(grid(join(ctx, [ops])));
    });

    const third = { id: 'id_3', name: 'third', order: 2, row: 4, column: 4 };
    const storedB1 = [{ r: 0, c: 1, v: { v: 7, m: '7' } }];

    it('applies a batch that adds a sheet and writes a cell on it', () => {
        const ops: Op[] = [
            add({ ...third, celldata: storedB1 }),
            { op: 'replace', id: 'id_3', path: ['data', 0, 0], value: { v: 9, m: '9' } },
        ];
        const ctx = makeCtx(null);
        const joiner = grid(join(ctx, [ops]));
        expect(joiner[2]?.cells).toEqual([{ r: 0, c: 0, v: { v: 9, m: '9' } }, ...storedB1]);
        expect(grid(applyPeerOps(ctx, ops).sheets)).toEqual(joiner);
    });

    it('skips a sheet add whose id is already a sheet', () => {
        const ops = [add({ ...third, id: 'id_2', celldata: storedB1 }), typedA1];
        const ctx = makeCtx(null);
        const joiner = grid(join(ctx, [ops]));
        expect(joiner).toEqual(grid(join(ctx, [[typedA1]])));
        expect(grid(applyPeerOps(ctx, ops).sheets)).toEqual(joiner);
    });

    it('keeps the cells of a sheet add that carries a matrix and no stored cells', () => {
        const ops = [add({ ...third, data: makeData({ v: 7, m: '7' }) }), typedA1];
        const ctx = makeCtx(null);
        const joiner = grid(join(ctx, [ops]));
        expect(joiner[2]?.cells).toEqual([{ r: 0, c: 0, v: { v: 5, m: '5' } }, ...storedB1]);
        expect(grid(applyPeerOps(ctx, ops).sheets)).toEqual(joiner);
    });
});

// A row or column op moves a merge in `config.merge`, and the cells it covers must follow: every cell points at the
// corner, and the corner holds the size. A peer's bare op carries no stamps, so a live client and a joiner each derive
// them, and must derive the same ones, or the compacted log stores the joiner's.
describe('applyOp and a joiner stamp a merge the same way after a row or column op', () => {
    // A 2 by 2 merge over C3:D4, so every case below is above, at an edge of, inside or below it on either axis.
    const merged = () =>
        produce(makeCtx(null), (draft: Context) => {
            const data = Array.from({ length: 8 }, () => Array.from({ length: 8 }, (): Cell | null => null));
            data[2][2] = { v: 1, m: '1', mc: { r: 2, c: 2, rs: 2, cs: 2 } };
            data[2][3] = { mc: { r: 2, c: 2 } };
            data[3][2] = { mc: { r: 2, c: 2 } };
            data[3][3] = { mc: { r: 2, c: 2 } };
            draft.sheets[0] = {
                ...draft.sheets[0],
                row: 8,
                column: 8,
                data,
                config: { merge: { '2_2': { r: 2, c: 2, rs: 2, cs: 2 } } },
            };
        });
    // Each cell's stamp, and each merge's stamps as `config.merge` says they must be.
    const stamps = (sheet: LibSheet) =>
        dataToCelldata(sheet.data).flatMap(({ r, c, v }) => (v?.mc ? [{ r, c, mc: v.mc }] : []));
    const expected = (sheet: LibSheet) =>
        Object.values(sheet.config?.merge ?? {}).flatMap(({ r, c, rs, cs }) =>
            Array.from({ length: rs * cs }, (_, i) => {
                const [row, column] = [r + Math.floor(i / cs), c + (i % cs)];
                return { r: row, c: column, mc: row === r && column === c ? { r, c, rs, cs } : { r, c } };
            }),
        );
    const byPlace = (a: { r: number; c: number }, b: { r: number; c: number }) => a.r - b.r || a.c - b.c;

    const insert = (type: 'row' | 'column', index: number, direction: 'lefttop' | 'rightbottom'): Op => ({
        op: 'insertRowCol',
        id: 'id_1',
        path: [],
        value: { type, index, count: 1, direction },
    });
    const remove = (type: 'row' | 'column', start: number, end: number): Op => ({
        op: 'deleteRowCol',
        id: 'id_1',
        path: [],
        value: { type, start, end },
    });

    it.each(
        (['row', 'column'] as const).flatMap((type): [string, Op][] => [
            [`a ${type} insert before the merge`, insert(type, 1, 'lefttop')],
            [`a ${type} insert at its first ${type}`, insert(type, 2, 'lefttop')],
            [`a ${type} insert after its first ${type}`, insert(type, 2, 'rightbottom')],
            [`a ${type} insert at its last ${type}`, insert(type, 3, 'lefttop')],
            [`a ${type} insert after its last ${type}`, insert(type, 3, 'rightbottom')],
            [`a ${type} insert after the merge`, insert(type, 5, 'lefttop')],
            [`a ${type} delete before the merge`, remove(type, 0, 0)],
            [`a ${type} delete across its first ${type}`, remove(type, 1, 2)],
            [`a ${type} delete of its first ${type}`, remove(type, 2, 2)],
            [`a ${type} delete of its last ${type}`, remove(type, 3, 3)],
            [`a ${type} delete across its last ${type}`, remove(type, 3, 4)],
            [`a ${type} delete of the whole merge`, remove(type, 2, 3)],
            [`a ${type} delete after the merge`, remove(type, 5, 5)],
        ]),
    )('%s', (_, op) => {
        const ctx = merged();
        const [joiner] = join(ctx, [[op]]);
        const [live] = applyPeerOps(ctx, [op]).sheets;
        expect(stamps(joiner).sort(byPlace)).toEqual(expected(joiner).sort(byPlace));
        expect(dataToCelldata(live.data)).toEqual(dataToCelldata(joiner.data));
        expect(live.config?.merge).toEqual(joiner.config?.merge);
    });
});

// A host replays the log from an earlier state when a peer's batch lands before batches the tab already applied.
describe('replayOps', () => {
    const typedA1: Op = { op: 'replace', id: 'id_1', path: ['data', 0, 0], value: { v: 9, m: '9' } };
    const typedB2: Op = { op: 'replace', id: 'id_1', path: ['data', 1, 1], value: { v: 'b2', m: 'b2' } };
    const rowInsert: Op = {
        op: 'insertRowCol',
        id: 'id_1',
        path: [],
        value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
    };
    const entry = { patches: [], inversePatches: [], options: {} };

    function replay(ctx: Context, base: Context['sheets'], batches: Op[][], fresh: Op[][]) {
        let next = ctx;
        const history = { undoList: [entry], redoList: [entry] };
        const api = generateAPIs(
            () => next,
            (recipe: (draft: Context) => void) => {
                next = produce(next, recipe);
            },
            () => {},
            () => {},
            history,
        );
        const accepted = api.replayOps(base, batches, new Set(fresh));
        return { ctx: next, history, accepted };
    }

    it('applies the batches on the base, clears both stacks and keeps the view', () => {
        const base = makeCtx(null);
        const shown = applyPeerOps(base, [typedA1]);
        const { ctx, history, accepted } = replay(shown, base.sheets, [[typedB2], [typedA1]], [[typedB2]]);
        expect([ctx.sheets[0].data?.[0][0]?.v, ctx.sheets[0].data?.[1][1]?.v]).toEqual([9, 'b2']);
        expect(history).toMatchObject({ undoList: [], redoList: [] });
        expect(ctx.selections).toBe(shown.selections);
        expect(accepted).toBe(true);
    });

    // The replay itself skips the formula graph, so a long one stays short, and the graph is built while the browser
    // idles.
    it('builds the formula graph again once the browser is idle', async () => {
        const shown = makeCtx({ f: '=A1*2', v: 10, m: '10' });
        heldGraph(shown);
        const { ctx } = replay(shown, shown.sheets, [[typedB2]], [[typedB2]]);
        expect(ctx.formulaCache.graph).toBeNull();
        await Bun.sleep(250);
        expect(ctx.formulaCache.graph?.formulaAt('id_1', 0, 1)?.formula).toBe('=A1*2');
    });

    it('says when a batch failed to apply', () => {
        const broken: Op = { op: 'replace', id: 'id_1', path: ['data', 99, 0, 'v'], value: 1 };
        const ctx = makeCtx(null);
        expect(replay(ctx, ctx.sheets, [[broken]], [[broken]]).accepted).toBe(false);
    });

    it('moves an open cell editor only for a batch new to the tab', () => {
        const ctx = produce(makeCtx(null), (draft: Context) => {
            draft.editingCellPosition = [2, 1];
        });
        const old = [rowInsert];
        const fresh = [{ ...rowInsert }];
        expect(replay(ctx, ctx.sheets, [old, fresh], [fresh]).ctx.editingCellPosition).toEqual([3, 1]);
    });

    it('closes an open cell editor when a batch the fresh one overtakes moves rows', () => {
        const base = produce(makeCtx(null), (draft: Context) => {
            draft.editingCellPosition = [2, 1];
        });
        const overtaken = [rowInsert];
        const shown = applyPeerOps(base, overtaken);
        expect(shown.editingCellPosition).toEqual([3, 1]);
        const late: Op[] = [{ op: 'deleteRowCol', id: 'id_1', path: [], value: { type: 'row', start: 2, end: 2 } }];
        const { ctx } = replay(shown, base.sheets, [late, overtaken], [late]);
        expect(ctx.editingCellPosition).toEqual([]);
    });

    // The tab can't tell where the selection went either, and a keystroke there would write over a peer's cell.
    it('drops the selection when it closes the editor', () => {
        const base = produce(makeCtx(null), (draft: Context) => {
            draft.editingCellPosition = [2, 1];
            draft.selections = sel(2, 2, 1, 1);
        });
        const overtaken = [rowInsert];
        const shown = applyPeerOps(base, overtaken);
        const late: Op[] = [{ op: 'deleteRowCol', id: 'id_1', path: [], value: { type: 'row', start: 0, end: 0 } }];
        const { ctx } = replay(shown, base.sheets, [late, overtaken], [late]);
        expect([ctx.editingCellPosition, ctx.selections]).toEqual([[], undefined]);
    });

    it('keeps the editor and the selection when the batch it overtakes moves no rows', () => {
        const shown = produce(makeCtx(null), (draft: Context) => {
            draft.editingCellPosition = [2, 1];
            draft.selections = sel(2, 2, 1, 1);
        });
        const lateInsert = [{ ...rowInsert }];
        const { ctx } = replay(shown, shown.sheets, [lateInsert, [typedB2]], [lateInsert]);
        expect(ctx.editingCellPosition).toEqual([3, 1]);
        expect(ctx.selections?.[0].row).toEqual([3, 3]);
    });

    // Every batch the tab applied before already moved its view once, so the replay applies it again without moving
    // the view.
    describe('moves the view only for a batch new to the tab', () => {
        const typed = [typedB2];

        it('a row delete on another sheet leaves the selection', () => {
            const shown = makeCtx(null);
            const old: Op[] = [{ op: 'deleteRowCol', id: 'id_2', path: [], value: { type: 'row', start: 0, end: 0 } }];
            const { ctx } = replay(shown, shown.sheets, [old, typed], [typed]);
            expect(ctx.selections?.[0].row).toEqual([0, 0]);
        });

        // The tab left id_1 with its selection on row 2 and is on id_2.
        const leftBehind = (ctx: Context) =>
            produce(ctx, (draft: Context) => {
                draft.selections = sel(2, 2, 1, 1);
                changeSheet(draft, 'id_2');
            });
        const insertAbove: Op[] = [
            {
                op: 'insertRowCol',
                id: 'id_1',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ];
        const deleteAbove: Op[] = [
            { op: 'deleteRowCol', id: 'id_1', path: [], value: { type: 'row', start: 0, end: 0 } },
        ];
        const kept = (ctx: Context) => ctx.sheetViewRecord.id_1?.selections?.[0].row;

        it('a row op it applied before moved the selection of a sheet the tab left once', () => {
            const base = makeCtx(null);
            const shown = applyPeerOps(leftBehind(base), insertAbove);
            expect(kept(replay(shown, base.sheets, [insertAbove, typed], [typed]).ctx)).toEqual([3, 3]);
        });

        it('a new row op moves it', () => {
            const base = makeCtx(null);
            const { ctx } = replay(leftBehind(base), base.sheets, [insertAbove, typed], [insertAbove]);
            expect(kept(ctx)).toEqual([3, 3]);
        });

        it('a delete it applied before does not move the selection a second time', () => {
            const base = produce(makeCtx(null), (draft: Context) => {
                draft.selections = sel(3, 3, 1, 1);
            });
            const shown = applyPeerOps(base, deleteAbove);
            expect(shown.selections?.[0].row).toEqual([2, 2]);
            expect(replay(shown, base.sheets, [deleteAbove, typed], [typed]).ctx.selections?.[0].row).toEqual([2, 2]);
        });

        it('a new delete of the selected row lands it once, on the grid the applied batches left', () => {
            const base = produce(makeCtx(null), (draft: Context) => {
                draft.selections = sel(3, 3, 1, 1);
            });
            const late: Op[] = [{ op: 'deleteRowCol', id: 'id_1', path: [], value: { type: 'row', start: 3, end: 3 } }];
            expect(replay(base, base.sheets, [typed, late], [late]).ctx.selections?.[0].row).toEqual([2, 2]);
        });

        it('a new row op ahead of an applied one drops it, since the tab cannot tell where it went', () => {
            const base = makeCtx(null);
            const shown = applyPeerOps(leftBehind(base), insertAbove);
            const { ctx } = replay(shown, base.sheets, [deleteAbove, insertAbove], [deleteAbove]);
            expect(kept(ctx)).toBeUndefined();
            expect(ctx.selections).toBe(shown.selections);
        });

        it('a hide and a show of the current sheet leave the tab on it', () => {
            const shown = makeCtx(null);
            const hide: Op[] = [{ op: 'replace', id: 'id_1', path: ['hide'], value: 1 }];
            const show: Op[] = [{ op: 'replace', id: 'id_1', path: ['hide'], value: 0 }];
            const { ctx } = replay(shown, shown.sheets, [hide, show, typed], [typed]);
            expect(ctx.currentSheetId).toBe('id_1');
        });

        it('a delete and a re-add of the current sheet leave the tab on it', () => {
            const shown = makeCtx(null, 'id_2');
            const del: Op[] = [{ op: 'deleteSheet', id: 'id_2', path: [], value: { id: 'id_2' } }];
            const add: Op[] = [{ op: 'addSheet', id: 'id_2', path: [], value: { ...shown.sheets[1], config: {} } }];
            const { ctx } = replay(shown, shown.sheets, [typed, del, add], [typed]);
            expect(ctx.currentSheetId).toBe('id_2');
        });

        it('a fresh hide of the current sheet moves the tab off it', () => {
            const shown = makeCtx(null);
            const hide: Op[] = [{ op: 'replace', id: 'id_1', path: ['hide'], value: 1 }];
            const { ctx } = replay(shown, shown.sheets, [hide, typed], [hide]);
            expect(ctx.currentSheetId).toBe('id_2');
        });
    });
});

// A peer's row or column op moves the cells under this tab's selection, so the selection moves with them, and the next
// keystroke lands on the cell the person chose.
describe("the selection follows a peer's row and column ops", () => {
    const selected = (r: number, c: number) =>
        produce(makeCtx(null), (draft: Context) => {
            draft.selections = sel(r, r, c, c);
        });
    const focus = (ctx: Context) => {
        const [selection] = ctx.selections ?? [];
        return selection && [selection.row, selection.column, selection.row_focus, selection.column_focus];
    };
    const insert = (type: 'row' | 'column', index: number, id = 'id_1'): Op => ({
        op: 'insertRowCol',
        id,
        path: [],
        value: { type, index, count: 1, direction: 'lefttop' },
    });
    const remove = (type: 'row' | 'column', start: number, end: number, id = 'id_1'): Op => ({
        op: 'deleteRowCol',
        id,
        path: [],
        value: { type, start, end },
    });

    it('an insert above or left of it moves it on', () => {
        expect(focus(applyPeerOps(selected(2, 1), [insert('row', 0)]))).toEqual([[3, 3], [1, 1], 3, 1]);
        expect(focus(applyPeerOps(selected(2, 1), [insert('column', 1)]))).toEqual([[2, 2], [2, 2], 2, 2]);
    });

    it('a delete above it moves it back, and one below it leaves it', () => {
        expect(focus(applyPeerOps(selected(2, 1), [remove('row', 0, 0)]))).toEqual([[1, 1], [1, 1], 1, 1]);
        expect(focus(applyPeerOps(selected(2, 1), [remove('row', 3, 3)]))).toEqual([[2, 2], [1, 1], 2, 1]);
    });

    it('a delete on another sheet leaves it', () => {
        expect(focus(applyPeerOps(selected(2, 1), [remove('row', 0, 0, 'id_2')]))).toEqual([[2, 2], [1, 1], 2, 1]);
    });

    it('a delete of its cell leaves it at that position, on what took its place', () => {
        expect(focus(applyPeerOps(selected(2, 1), [remove('row', 1, 2)]))).toEqual([[1, 1], [1, 1], 1, 1]);
        expect(focus(applyPeerOps(selected(1, 1), [remove('row', 1, 1)]))).toEqual([[1, 1], [1, 1], 1, 1]);
        expect(focus(applyPeerOps(selected(2, 1), [remove('column', 0, 1)]))).toEqual([[2, 2], [0, 0], 2, 0]);
    });

    it('a delete of the last row or column clamps it to the grid', () => {
        expect(focus(applyPeerOps(selected(3, 3), [remove('row', 3, 3)]))).toEqual([[2, 2], [3, 3], 2, 3]);
        expect(focus(applyPeerOps(selected(3, 3), [remove('column', 3, 3)]))).toEqual([[3, 3], [2, 2], 3, 2]);
        expect(focus(applyPeerOps(selected(3, 1), [remove('row', 2, 3)]))).toEqual([[1, 1], [1, 1], 1, 1]);
    });

    it('each delete of a batch lands it on the grid that delete left', () => {
        const batch = [remove('row', 3, 3), remove('row', 2, 2)];
        expect(focus(applyPeerOps(selected(3, 1), batch))).toEqual([[1, 1], [1, 1], 1, 1]);
    });

    // Two peers each deleting most of the rows can leave none, which every reader applies. No cell is left to land on,
    // and the keys throw on a selection with no cell under it.
    it('a delete of every row or column applies and drops the selection', () => {
        const rows = applyPeerOps(selected(2, 1), [remove('row', 0, 3)]);
        expect(rows.sheets[0].data).toEqual([]);
        expect(rows.selections).toBeUndefined();
        const columns = applyPeerOps(selected(2, 1), [remove('column', 0, 3)]);
        expect(columns.sheets[0].data?.[0]).toEqual([]);
        expect(columns.selections).toBeUndefined();
    });

    it('a delete of every row on a sheet the tab left drops the selection kept for it', () => {
        expect(applyPeerOps(leftBehind(), [remove('row', 0, 3)]).sheetViewRecord.id_1?.selections).toBeUndefined();
    });

    describe('a landing on a merged cell', () => {
        // B2:C3 merged, in the four by four grid.
        const merged = (r: number, c: number) =>
            produce(selected(r, c), (draft: Context) => {
                const [sheet] = draft.sheets;
                sheet.config = { merge: { '1_1': { r: 1, c: 1, rs: 2, cs: 2 } } };
                const { data } = sheet;
                if (!data) return;
                data[1][1] = { v: 'HEAD', m: 'HEAD', mc: { r: 1, c: 1, rs: 2, cs: 2 } };
                data[1][2] = { mc: { r: 1, c: 1 } };
                data[2][1] = { mc: { r: 1, c: 1 } };
                data[2][2] = { mc: { r: 1, c: 1 } };
            });

        it('takes the head, with the box over the merge', () => {
            expect(focus(applyPeerOps(merged(0, 2), [remove('row', 0, 0)]))).toEqual([[0, 1], [1, 2], 0, 1]);
            expect(focus(applyPeerOps(merged(2, 0), [remove('column', 0, 0)]))).toEqual([[1, 2], [0, 1], 1, 0]);
        });

        it('takes the head when the clamp puts it there', () => {
            const clamped = applyPeerOps(merged(3, 2), [remove('row', 3, 3)]);
            expect(focus(clamped)).toEqual([[1, 2], [1, 2], 1, 1]);
        });

        it('takes the head on a sheet the tab left', () => {
            const left = produce(merged(0, 2), (draft: Context) => {
                changeSheet(draft, 'id_2');
            });
            expect(focus(backOnFirst(applyPeerOps(left, [remove('row', 0, 0)])))).toEqual([[0, 1], [1, 2], 0, 1]);
        });

        it('leaves a selection a delete only moves on the cell it was on', () => {
            const moved = produce(merged(3, 2), (draft: Context) => {
                draft.selections = [{ row: [3, 3], column: [0, 3], row_focus: 3, column_focus: 2, row_select: true }];
            });
            const [selection] = applyPeerOps(moved, [remove('row', 0, 0)]).selections ?? [];
            expect(selection).toMatchObject({ row: [2, 2], column: [0, 3], row_focus: 2, column_focus: 2 });
        });

        it('keeps a whole row selected from its header, and grows it over the merge it lands on', () => {
            const whole = produce(merged(0, 0), (draft: Context) => {
                draft.selections = [{ row: [0, 0], column: [0, 3], row_focus: 0, column_focus: 2, row_select: true }];
            });
            const [selection] = applyPeerOps(whole, [remove('row', 0, 0)]).selections ?? [];
            expect(selection).toMatchObject({
                row: [0, 1],
                column: [0, 3],
                row_focus: 0,
                column_focus: 1,
                row_select: true,
            });
        });
    });

    it('a whole row or column selected from its header stays on that number', () => {
        const wholeRow = produce(makeCtx(null), (draft: Context) => {
            draft.selections = [{ row: [2, 2], column: [0, 3], row_select: true, row_focus: 2, column_focus: 0 }];
        });
        const [row] = applyPeerOps(wholeRow, [remove('row', 2, 2)]).selections ?? [];
        expect(row).toMatchObject({ row: [2, 2], column: [0, 3], row_select: true });
        const wholeColumn = produce(makeCtx(null), (draft: Context) => {
            draft.selections = [{ row: [0, 3], column: [3, 3], column_select: true, row_focus: 0, column_focus: 3 }];
        });
        const [column] = applyPeerOps(wholeColumn, [remove('column', 3, 3)]).selections ?? [];
        expect(column).toMatchObject({ row: [0, 3], column: [2, 2], column_select: true });
    });

    it('a range that loses part of its rows shrinks, and one it loses whole lands with its focus', () => {
        const range = produce(makeCtx(null), (draft: Context) => {
            draft.selections = [{ row: [1, 3], column: [0, 1], row_focus: 2, column_focus: 1 }];
        });
        expect(focus(applyPeerOps(range, [remove('row', 2, 2)]))).toEqual([[1, 2], [0, 1], 1, 1]);
        expect(focus(applyPeerOps(range, [remove('row', 1, 3)]))).toEqual([[0, 0], [0, 1], 0, 1]);
    });

    it('in a multi-selection one taken whole lands and the others move', () => {
        const two = produce(makeCtx(null), (draft: Context) => {
            draft.selections = [...sel(1, 1, 1, 1), ...sel(3, 3, 0, 0)];
        });
        const rows = applyPeerOps(two, [remove('row', 1, 1)]).selections?.map(({ row }) => row);
        expect(rows).toEqual([
            [1, 1],
            [2, 2],
        ]);
    });

    // The tab left id_1 with its selection on row 2 and is on id_2.
    const leftBehind = () =>
        produce(selected(2, 1), (draft: Context) => {
            changeSheet(draft, 'id_2');
        });
    const backOnFirst = (ctx: Context) =>
        produce(ctx, (draft: Context) => {
            changeSheet(draft, 'id_1');
        });

    it('on a sheet the tab left it moves too, and a switch back finds it on its cell', () => {
        expect(focus(backOnFirst(applyPeerOps(leftBehind(), [remove('row', 0, 0)])))).toEqual([[1, 1], [1, 1], 1, 1]);
        expect(focus(backOnFirst(applyPeerOps(leftBehind(), [insert('column', 0)])))).toEqual([[2, 2], [2, 2], 2, 2]);
    });

    it('on a sheet the tab left a delete of its cell lands it the same way, and the current one stays', () => {
        const left = leftBehind();
        const peer = applyPeerOps(left, [remove('row', 2, 2)]);
        expect(peer.selections).toEqual(left.selections);
        expect(focus(backOnFirst(peer))).toEqual([[2, 2], [1, 1], 2, 1]);
    });

    it('a delete on a sheet the tab left clamps it to that sheet, not the current one', () => {
        const small = produce(leftBehind(), (draft: Context) => {
            draft.sheets[1].data = draft.sheets[1].data?.slice(0, 1);
            const left = draft.sheetViewRecord.id_1;
            if (left) left.selections = sel(3, 3, 1, 1);
        });
        const peer = applyPeerOps(small, [remove('row', 3, 3)]);
        expect(peer.sheetViewRecord.id_1?.selections?.[0].row).toEqual([2, 2]);
    });
});
