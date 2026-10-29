// applyOp keeps the formula dependency map in step with a peer's cell edits: the map counts
// as built once it exists, so a formula that arrives over the wire is only tracked if
// applyOp registers it.

import { describe, expect, it } from 'bun:test';
import type { Sheet as LibSheet } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { dataToCelldata } from '../../../engine/celldata';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import type { Op } from '../../../state/types';
import { emitOps, join } from '../../state/factories/collab';
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
            {
                name: 'first',
                id: 'id_1',
                order: 0,
                row: 4,
                column: 4,
                data,
                calcChain: b1?.f ? [{ r: 0, c: 1, id: 'id_1' }] : [],
            },
            { name: 'second', id: 'id_2', order: 1, row: 4, column: 4, data: makeData(null), calcChain: [] },
        ],
    }) as Context;
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

    it('leaves the formula map alone when a batch fails after adding a sheet with formulas', () => {
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
        const before = { ...warmFormulaCellInfoMap(ctx) };
        const next = applyPeerOps(ctx, ops);
        expect(summary(next.sheets)).toEqual(summary(join(ctx, [ops])));
        expect({ ...next.formulaCache.formulaCellInfoMap }).toEqual(before);
    });

    it('gives a sheet that has only its stored cells a matrix before a row or cell op on it', () => {
        const ops: Op[] = [
            {
                op: 'insertRowCol',
                id: 'id_2',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_2' },
            },
            { op: 'replace', id: 'id_2', path: ['data', 0, 0], value: { v: 9, m: '9' } },
        ];
        const ctx = produce(makeCtx(null), (draft: Context) => {
            draft.sheets[1].celldata = [{ r: 0, c: 1, v: { v: 7, m: '7' } }];
            delete draft.sheets[1].data;
        });
        const [, joiner] = join(ctx, [ops]);
        expect(dataToCelldata(joiner.data)).toEqual([
            { r: 0, c: 0, v: { v: 9, m: '9' } },
            { r: 1, c: 1, v: { v: 7, m: '7' } },
        ]);
        expect(dataToCelldata(applyPeerOps(ctx, ops).sheets[1].data)).toEqual(dataToCelldata(joiner.data));
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

    it('skips an insert into a read-only row and applies the rest, as the replay does', () => {
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
            draft.sheets[0].config = { rowReadOnly: { 1: 1 } };
        });
        const [joiner] = join(ctx, [ops]);
        expect(joiner.data?.[0][0]?.v).toBe(9);
        expect(applyPeerOps(ctx, ops).sheets[0].data).toEqual(joiner.data);
    });
});

// The replay skips a sheet or row op whose value has the wrong shape and applies the rest of the batch. A live client
// must skip the same ops, or it keeps a row or a sheet that every joiner, and the compacted log, lacks. The sheet adds
// it does take must end with the same cells on both paths.
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
