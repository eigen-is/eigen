// Charts ride the op pipeline as a map keyed by chart id, so these tests drive the real one: an
// editor recipe through produceWithPatches → patchToOp, a peer through Workbook's applyOp, and a
// joiner through replaySheetsOps. Every client and the joiner must end on the same charts.

import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE, parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import {
    decodeSheetsSnapshot,
    encodeSheetsSnapshot,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_ROW_HEIGHT,
    type SheetChart,
} from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { orderByFractionalIndex } from '@workspace/lib/vector';
import { applyPatches, enablePatches, type Patch, produce, produceWithPatches } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { replaySheetsOps } from '../../../engine';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import { initSheetData } from '../../../state/api/sheet';
import { addSheet } from '../../../state/api/workbook';
import type { Context } from '../../../state/context';
import {
    deleteChart,
    editsDeletedChart,
    insertChart,
    pasteChart,
    reorderChart,
    setChartSpec,
    updateChartBox,
} from '../../../state/modules/chart';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Op, Sheet } from '../../../state/types';
import { filterPatch, inverseRowColOptions, type PatchOptions, patchToOp } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

const S = 'id_1';
const T = 'id_2';
const BOX = { x: 10, y: 20, width: 400, height: 300 };
const SPEC = JSON.stringify(sampleChartSpec('column'));

const ref = (sheetId: string, row: [number, number], column: [number, number] = [1, 1]): CellRangeRef => ({
    sheetId,
    row,
    column,
});

function rangeSpec(values: CellRangeRef, categories: CellRangeRef | null = null): ChartSpec {
    const series = { name: 'Points', values, color: '#2a78d6', markers: false, smooth: false };
    return { ...sampleChartSpec('column'), data: { source: 'range', categories, series: [series] } };
}

function chart(id: string, spec: ChartSpec, index = 'a0'): SheetChart {
    return { id, index, ...BOX, spec: JSON.stringify(spec) };
}

const grid = () => Array.from({ length: 10 }, () => Array.from({ length: 4 }, () => null));

// S holds c1 and c2 over its own rows; T holds t1, whose values and categories live on S.
function workbook(): Context {
    const ctx = contextFactory({
        sheets: [
            {
                name: 'S',
                id: S,
                order: 0,
                data: grid(),
                charts: {
                    c1: chart('c1', rangeSpec(ref(S, [2, 5]))),
                    c2: chart('c2', rangeSpec(ref(S, [2, 5], [2, 2])), 'a1'),
                },
            },
            {
                name: 'T',
                id: T,
                order: 1,
                data: grid(),
                charts: { t1: chart('t1', rangeSpec(ref(S, [2, 5]), ref(S, [3, 4], [0, 0]))) },
            },
        ],
    }) as Context;
    for (const sheet of ctx.sheets) normalizeSheetConfig(sheet);
    return ctx;
}

// One edit as setContextWithProduce records it: the new state, its ops and its undo entry.
function author(base: Context, recipe: (ctx: Context) => void, options?: PatchOptions) {
    const [next, patches, inverse] = produceWithPatches(base, recipe);
    return {
        next,
        ops: patchToOp(next, filterPatch(patches), options),
        patches: filterPatch(patches),
        inverse: filterPatch(inverse),
    };
}

// A peer applies a batch through the Workbook's own applyOp.
function receive(ctx: Context, ops: Op[]): Context {
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

const join = (base: Context, batches: Op[][]) => replaySheetsOps(structuredClone(base.sheets), batches);
const charts = (sheets: Sheet[]) => sheets.map((sheet) => sheet.charts);
const paintOrder = (ctx: Context) => orderByFractionalIndex(Object.values(ctx.sheets[0].charts!)).map((c) => c.id);
const rangeData = (sheets: Sheet[], sheet: number, id: string) => {
    const spec = parseChartSpec(sheets[sheet].charts![id].spec);
    return spec?.data.source === 'range' ? spec.data : null;
};

describe('chart writers', () => {
    test('insert writes one new key above every chart', () => {
        const { next, ops } = author(workbook(), (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')));
        expect(ops).toEqual([{ op: 'add', id: S, path: ['charts', 'c3'], value: next.sheets[0].charts!.c3 }]);
        expect(next.sheets[0].charts!.c3.index > 'a1').toBe(true);
        expect(parseChartSpec(next.sheets[0].charts!.c3.spec)).toEqual(sampleChartSpec('line'));
    });

    test('a move or resize writes only the fields that changed', () => {
        const { ops } = author(workbook(), (ctx) => updateChartBox(ctx, 'c1', { x: 300, y: 20, width: 500 }));
        expect(ops.map((op) => [op.op, op.path])).toEqual([
            ['replace', ['charts', 'c1', 'x']],
            ['replace', ['charts', 'c1', 'width']],
        ]);
    });

    // A pasted size or a resize past the largest side would stall every peer's painter, and at a trillion px overflow it.
    test('insert, paste, move and resize store a side past the max as the max, and the corner on the grid', () => {
        const huge = { x: -5, y: 9.4e11, width: 9.4e11, height: 1e9 };
        const inserted = author(workbook(), (ctx) => insertChart(ctx, 'c3', huge, sampleChartSpec('line')));
        expect(inserted.next.sheets[0].charts!.c3).toMatchObject({
            x: 0,
            y: REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT,
            width: CHART_MAX_SIDE,
            height: CHART_MAX_SIDE,
        });
        const pasted = author(workbook(), (ctx) => pasteChart(ctx, 'c3', SPEC, { width: 9.4e11, height: 300 }));
        expect(pasted.next.sheets[0].charts!.c3).toMatchObject({ x: 0, y: 0, width: CHART_MAX_SIDE, height: 300 });
        const resized = author(workbook(), (ctx) => updateChartBox(ctx, 'c1', { x: -40, width: 9.4e11 }));
        expect(resized.ops.map((op) => [op.path, op.value])).toEqual([
            [['charts', 'c1', 'x'], 0],
            [['charts', 'c1', 'width'], CHART_MAX_SIDE],
        ]);
    });

    test('a spec edit is one replace of the spec string', () => {
        const spec = { ...rangeSpec(ref(S, [2, 5])), type: 'line' } as const;
        const { ops } = author(workbook(), (ctx) => setChartSpec(ctx, 'c1', spec));
        expect(ops).toEqual([{ op: 'replace', id: S, path: ['charts', 'c1', 'spec'], value: JSON.stringify(spec) }]);
    });

    test('bring forward and send backward write one index each', () => {
        const forward = author(workbook(), (ctx) => reorderChart(ctx, 'c1', 'forward'));
        expect(paintOrder(forward.next)).toEqual(['c2', 'c1']);
        expect(forward.ops.map((op) => op.path)).toEqual([['charts', 'c1', 'index']]);
        const backward = author(workbook(), (ctx) => reorderChart(ctx, 'c2', 'backward'));
        expect(paintOrder(backward.next)).toEqual(['c2', 'c1']);
        expect(author(workbook(), (ctx) => reorderChart(ctx, 'c2', 'forward')).ops).toEqual([]);
        expect(author(workbook(), (ctx) => reorderChart(ctx, 'c1', 'backward')).ops).toEqual([]);
    });

    test('equal indexes, as two peers inserting at once leave them, order by id and move as a pair', () => {
        const base = workbook();
        base.sheets[0].charts!.c3 = chart('c3', rangeSpec(ref(S, [0, 1])), 'a1');
        expect(paintOrder(base)).toEqual(['c1', 'c2', 'c3']);
        expect(paintOrder(author(base, (ctx) => reorderChart(ctx, 'c1', 'forward')).next)).toEqual(['c2', 'c3', 'c1']);
        expect(paintOrder(author(base, (ctx) => reorderChart(ctx, 'c3', 'backward')).next)).toEqual(['c1', 'c3', 'c2']);
    });

    test('delete removes the one key', () => {
        const { ops } = author(workbook(), (ctx) => deleteChart(ctx, 'c1'));
        expect(ops).toEqual([{ op: 'remove', id: S, path: ['charts', 'c1'] }]);
    });

    test('a viewer writes nothing', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.allowEdit = false;
        });
        for (const recipe of [
            (ctx: Context) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')),
            (ctx: Context) => updateChartBox(ctx, 'c1', { x: 1 }),
            (ctx: Context) => setChartSpec(ctx, 'c1', sampleChartSpec('pie')),
            (ctx: Context) => reorderChart(ctx, 'c1', 'forward'),
            (ctx: Context) => deleteChart(ctx, 'c1'),
        ]) {
            expect(author(base, recipe).ops).toEqual([]);
        }
    });
});

describe("the Workbook's insertChart", () => {
    function insertThroughApi(base: Context) {
        let next = base;
        const setContext = (recipe: (draft: Context) => void) => {
            next = produce(next, recipe);
        };
        // biome-ignore lint/suspicious/noExplicitAny: insertChart reads no settings
        const settings = {} as any;
        const api = generateAPIs(
            base,
            setContext,
            () => {},
            () => {},
            settings,
        );
        const id = api.insertChart(BOX, sampleChartSpec('bar'));
        return { id, next };
    }

    test('returns the id of the chart it inserted', () => {
        const { id, next } = insertThroughApi(workbook());
        expect(id).toBeString();
        expect(next.sheets[0].charts![id!]).toBeDefined();
    });

    test('returns null and writes nothing for a viewer or without a current sheet', () => {
        const viewer = produce(workbook(), (ctx: Context) => {
            ctx.allowEdit = false;
        });
        const noSheet = produce(workbook(), (ctx: Context) => {
            ctx.currentSheetId = 'gone';
        });
        for (const base of [viewer, noSheet]) {
            const { id, next } = insertThroughApi(base);
            expect(id).toBeNull();
            expect(next).toBe(base);
        }
    });
});

describe('every sheet entry carries a charts map', () => {
    test('initSheetData and addSheet materialize it', () => {
        const ctx = contextFactory() as Context;
        initSheetData(ctx, 0, ctx.sheets[0]);
        expect(ctx.sheets[0].charts).toEqual({});
        // biome-ignore lint/suspicious/noExplicitAny: addSheet reads only these settings
        const settings: any = { allowEdit: true, row: 10, column: 4, generateSheetId: () => 'id_3' };
        addSheet(ctx, settings);
        expect(ctx.sheets[2].charts).toEqual({});
    });

    test("a materialized writer's first chart replays on a base stored without charts", () => {
        const stored: Sheet[] = [{ id: S, name: 'S', order: 0, celldata: [], config: {} }];
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(stored, { computed: true }));
        delete decoded[0].charts;
        const { next, ops } = author(workbook(), (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('bar')));
        expect(replaySheetsOps(decoded, [ops])[0].charts).toEqual({ c3: next.sheets[0].charts!.c3 });
    });
});

describe('charts converge over real ops', () => {
    test('three clients editing different charts end identical, and so does a joiner', () => {
        const base = workbook();
        const a = author(base, (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('pie')));
        const b = author(base, (ctx) => updateChartBox(ctx, 'c1', { x: 300, y: 40 }));
        const c = author(base, (ctx) => setChartSpec(ctx, 'c2', sampleChartSpec('line')));
        const onA = receive(receive(a.next, b.ops), c.ops);
        const onB = receive(receive(b.next, c.ops), a.ops);
        const onC = receive(receive(c.next, a.ops), b.ops);
        const joiner = join(base, [b.ops, a.ops, c.ops]);
        expect(charts(onB.sheets)).toEqual(charts(onA.sheets));
        expect(charts(onC.sheets)).toEqual(charts(onA.sheets));
        expect(charts(joiner)).toEqual(charts(onA.sheets));
        expect(Object.keys(onA.sheets[0].charts!).sort()).toEqual(['c1', 'c2', 'c3']);
    });

    test('a row insert on S shifts charts on S and on T alike on author, peer and joiner', () => {
        const base = workbook();
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
        const insert = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        const peer = receive(base, insert.ops);
        const joiner = join(base, [insert.ops]);
        expect(rangeData(insert.next.sheets, 0, 'c1')?.series[0].values?.row).toEqual([4, 7]);
        expect(rangeData(insert.next.sheets, 1, 't1')?.series[0].values?.row).toEqual([4, 7]);
        expect(charts(peer.sheets)).toEqual(charts(insert.next.sheets));
        expect(charts(joiner)).toEqual(charts(insert.next.sheets));
    });

    test('undoing a row delete restores a shrunk ref on S and a nulled ref on T everywhere', () => {
        const base = workbook();
        const del = { type: 'row', start: 3, end: 6, id: S } as const;
        const deleted = author(base, (ctx) => deleteRowCol(ctx, del), { deleteRowColOp: del });
        expect(rangeData(deleted.next.sheets, 0, 'c1')?.series[0].values?.row).toEqual([2, 2]);
        expect(rangeData(deleted.next.sheets, 1, 't1')?.categories).toBeNull();

        // Workbook's handleUndo: apply the inverse locally, ship it as an insert that restores cells.
        const undone = applyPatches(deleted.next, deleted.inverse);
        const undoOptions = inverseRowColOptions({ deleteRowColOp: del });
        const undoOps = patchToOp(undone, deleted.inverse, { ...undoOptions, restoreDeletedCells: true }, true);

        const peer = receive(receive(base, deleted.ops), undoOps);
        const joiner = join(base, [deleted.ops, undoOps]);
        expect(charts(undone.sheets)).toEqual(charts(base.sheets));
        expect(charts(peer.sheets)).toEqual(charts(base.sheets));
        expect(charts(joiner)).toEqual(charts(base.sheets));
    });

    // Workbook's handleUndo and handleRedo, after a peer typed 42 in T!A1 and moved t1.
    function undoRedoAfterPeer(base: Context, peerEdit: Op[]) {
        const del = { type: 'row', start: 3, end: 6, id: S } as const;
        const deleted = author(base, (ctx) => deleteRowCol(ctx, del), { deleteRowColOp: del });
        const undone = applyPatches(receive(deleted.next, peerEdit), deleted.inverse);
        const undoOptions = { ...inverseRowColOptions({ deleteRowColOp: del }), restoreDeletedCells: true };
        const undoOps = patchToOp(undone, deleted.inverse, undoOptions, true);
        const redone = applyPatches(undone, deleted.patches);
        const redoOps = patchToOp(redone, deleted.patches, { deleteRowColOp: del });
        const peerUndone = receive(receive(receive(base, deleted.ops), peerEdit), undoOps);
        return {
            undo: {
                author: undone.sheets,
                peer: peerUndone.sheets,
                joiner: join(base, [deleted.ops, peerEdit, undoOps]),
            },
            redo: {
                author: redone.sheets,
                peer: receive(peerUndone, redoOps).sheets,
                joiner: join(base, [deleted.ops, peerEdit, undoOps, redoOps]),
            },
        };
    }

    const peerEdit: Op[] = [
        { op: 'replace', id: T, path: ['data', 0, 0], value: { v: 42, m: '42' } },
        { op: 'replace', id: T, path: ['charts', 't1', 'x'], value: 99 },
    ];

    test("undoing and redoing a row delete keeps a peer's edit on the sheet of a shifted chart", () => {
        const base = workbook();
        const { undo, redo } = undoRedoAfterPeer(base, peerEdit);
        for (const { author, peer, joiner } of [undo, redo]) {
            for (const sheets of [author, peer, joiner]) expect(sheets[1].data![0][0]).toEqual({ v: 42, m: '42' });
            expect(charts(peer)).toEqual(charts(author));
            expect(charts(joiner)).toEqual(charts(author));
        }
        expect(rangeData(undo.author, 1, 't1')).toEqual(rangeData(base.sheets, 1, 't1'));
        expect(rangeData(redo.author, 1, 't1')?.categories).toBeNull();
    });

    test('an undone row delete brings back a shifted chart a peer deleted, on every client', () => {
        const { undo, redo } = undoRedoAfterPeer(workbook(), [{ op: 'remove', id: T, path: ['charts', 't1'] }]);
        for (const { author, peer, joiner } of [undo, redo]) {
            expect(author[1].charts!.t1).toBeDefined();
            expect(charts(peer)).toEqual(charts(author));
            expect(charts(joiner)).toEqual(charts(author));
        }
    });

    test('an undone row delete restores a chart on a sheet whose formula moved too, everywhere', () => {
        const base = workbook();
        base.sheets[1].data![9][3] = { f: '=SUM(S!B3:B6)', v: 0, m: '0' };
        const { undo, redo } = undoRedoAfterPeer(base, []);
        expect(rangeData(undo.author, 1, 't1')).toEqual(rangeData(base.sheets, 1, 't1'));
        for (const { author, peer, joiner } of [undo, redo]) {
            expect(charts(peer)).toEqual(charts(author));
            expect(charts(joiner)).toEqual(charts(author));
        }
    });

    test('redoing a row delete after a peer moved a chart on a sheet whose formula moved too ends identical', () => {
        const base = workbook();
        base.sheets[1].data![9][3] = { f: '=SUM(S!B3:B6)', v: 0, m: '0' };
        const del = { type: 'row', start: 3, end: 6, id: S } as const;
        const deleted = author(base, (ctx) => deleteRowCol(ctx, del), { deleteRowColOp: del });
        const undone = applyPatches(deleted.next, deleted.inverse);
        const undoOptions = { ...inverseRowColOptions({ deleteRowColOp: del }), restoreDeletedCells: true };
        const undoOps = patchToOp(undone, deleted.inverse, undoOptions, true);
        const peerMove: Op[] = [{ op: 'replace', id: T, path: ['charts', 't1', 'x'], value: 99 }];
        const redone = applyPatches(receive(undone, peerMove), deleted.patches);
        const redoOps = patchToOp(redone, deleted.patches, { deleteRowColOp: del });
        const peer = receive(receive(receive(receive(base, deleted.ops), undoOps), peerMove), redoOps);
        const joiner = join(base, [deleted.ops, undoOps, peerMove, redoOps]);
        expect(charts(peer.sheets)).toEqual(charts(redone.sheets));
        expect(charts(joiner)).toEqual(charts(redone.sheets));
    });

    test('undoing a row insert restores a ref an insert stopped at the last row, on a sheet whose formula moved too', () => {
        const base = workbook();
        base.sheets[1].data![9][3] = { f: '=SUM(S!B3:B6)', v: 0, m: '0' };
        base.sheets[1].charts!.t1 = chart('t1', rangeSpec(ref(S, [0, 1048575])));
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
        const insert = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(rangeData(insert.next.sheets, 1, 't1')?.series[0].values?.row).toEqual([2, 1048575]);
        const undone = applyPatches(insert.next, insert.inverse);
        const undoOps = patchToOp(undone, insert.inverse, inverseRowColOptions({ insertRowColOp: op }), true);
        const peer = receive(receive(base, insert.ops), undoOps);
        const joiner = join(base, [insert.ops, undoOps]);
        expect(charts(undone.sheets)).toEqual(charts(base.sheets));
        expect(charts(peer.sheets)).toEqual(charts(base.sheets));
        expect(charts(joiner)).toEqual(charts(base.sheets));
    });
});

describe('an undo entry on a chart a peer deleted', () => {
    test('is recognized before it is applied, so it can be dropped', () => {
        const base = workbook();
        const move = author(base, (ctx) => updateChartBox(ctx, 'c1', { x: 300 }));
        const gone = receive(move.next, author(base, (ctx) => deleteChart(ctx, 'c1')).ops);
        expect(editsDeletedChart(gone, move.inverse)).toBe(true);
        expect(() => applyPatches(gone, move.inverse)).toThrow();
        expect(editsDeletedChart(move.next, move.inverse)).toBe(false);
    });

    test("the chart's own insert and delete stay undoable", () => {
        const base = workbook();
        const removed = author(base, (ctx) => deleteChart(ctx, 'c1'));
        const inserted = author(base, (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('bar')));
        const patches: Patch[] = [...removed.inverse, ...inserted.inverse];
        expect(editsDeletedChart(removed.next, patches)).toBe(false);
    });
});
