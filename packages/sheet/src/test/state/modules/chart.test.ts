// Charts ride the op pipeline as a map keyed by chart id, so these tests drive the real one: an
// editor recipe through produceWithPatches → patchToOp, a peer through Workbook's applyOp, and a
// joiner through replaySheetsOps. Every client and the joiner must end on the same charts.

import { describe, expect, test } from 'bun:test';
import {
    CHART_MAX_SIDE,
    DEFAULT_CHART_SERIES_STYLE,
    FLAT_CHART_LOOK,
    MAX_CHART_SPEC_ENTRIES,
    newSheetChartSpecParts,
    readChartLook,
    readChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import {
    decodeSheetsSnapshot,
    encodeSheetsSnapshot,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import { applyPatches, enablePatches, produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { mapChartRefs, replaySheetsOps } from '../../../engine';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import { initSheetData } from '../../../state/api/sheet';
import { addSheet } from '../../../state/api/workbook';
import type { Context } from '../../../state/context';
import {
    insertChart,
    pasteChart,
    setChartDataRange,
    setChartLook,
    setChartSpec,
    sheetChartSvg,
} from '../../../state/modules/chart';
import { updateFloatingBox, withoutDeletedFloatingEdits } from '../../../state/modules/floating';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Op, Sheet } from '../../../state/types';
import { inverseRowColOptions, patchToOp } from '../../../state/utils/patch';
import { author, join, receive } from '../factories/collab';
import { contextFactory } from '../factories/context';

enablePatches();

const S = 'id_1';
const T = 'id_2';
const BOX = { x: 10, y: 20, width: 400, height: 300 };
const SPEC = JSON.stringify(sampleChartSpec('column'));
const TO_LINE: ChartSpecChange = [{ op: 'set', path: ['chart', 'type'], value: 'line' }];

const ref = (sheetId: string, row: [number, number], column: [number, number] = [1, 1]): CellRangeRef => ({
    sheetId,
    row,
    column,
});

function rangeSpec(values: CellRangeRef, categories: CellRangeRef | null = null): ChartSpec {
    return {
        ...sampleChartSpec('column'),
        series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
        data: { source: 'range', categories, series: [{ id: 's-1', name: 'Points', values }] },
    };
}

function asLine(spec: ChartSpec): ChartSpec {
    return { ...spec, chart: { ...spec.chart, type: 'line' } };
}

function chart(id: string, spec: ChartSpec, index = 'a0'): SheetChart {
    return { id, index, ...BOX, ...newSheetChartSpecParts(spec) };
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

const charts = (sheets: Sheet[]) => sheets.map((sheet) => sheet.charts);
const rangeData = (sheets: Sheet[], sheet: number, id: string) => {
    const { spec } = readChartSpec(sheets[sheet].charts![id]);
    return spec?.data.source === 'range' ? spec.data : null;
};

describe('chart writers', () => {
    test('insert writes one new key above every chart', () => {
        const { next, ops } = author(workbook(), (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')));
        expect(ops).toEqual([{ op: 'add', id: S, path: ['charts', 'c3'], value: next.sheets[0].charts!.c3 }]);
        expect(next.sheets[0].charts!.c3.index > 'a1').toBe(true);
        expect(readChartSpec(next.sheets[0].charts!.c3).spec).toEqual(sampleChartSpec('line'));
    });

    // A pasted size past the largest side would stall every peer's painter, and at a trillion px overflow it.
    test('insert and paste store a side past the max as the max, and the corner on the grid', () => {
        const huge = { x: -5, y: 9.4e11, width: 9.4e11, height: 1e9 };
        const inserted = author(workbook(), (ctx) => insertChart(ctx, 'c3', huge, sampleChartSpec('line')));
        expect(inserted.next.sheets[0].charts!.c3).toMatchObject({
            x: 0,
            y: REFERENCE_ROW_COUNT * SHEET_DEFAULT_ROW_HEIGHT,
            width: CHART_MAX_SIDE,
            height: CHART_MAX_SIDE,
        });
        const pasted = author(workbook(), (ctx) =>
            pasteChart(ctx, 'c3', SPEC, { width: 9.4e11, height: 300 }, FLAT_CHART_LOOK),
        );
        expect(pasted.next.sheets[0].charts!.c3).toMatchObject({ x: 0, y: 0, width: CHART_MAX_SIDE, height: 300 });
    });

    test('a type edit is one replace of its part', () => {
        const { chart } = asLine(rangeSpec(ref(S, [2, 5])));
        const { ops } = author(workbook(), (ctx) => setChartSpec(ctx, 'c1', TO_LINE));
        expect(ops).toEqual([
            { op: 'replace', id: S, path: ['charts', 'c1', 'specChart'], value: JSON.stringify(chart) },
        ]);
    });

    // Insert → Chart stays flat, with a seed of its own so a sketch picked later jitters the same everywhere.
    test('insert stores a random seed and no other look field', () => {
        const { next } = author(workbook(), (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')));
        const inserted = next.sheets[0].charts!.c3;
        const lookFields = Object.keys(inserted).filter((key) => key in FLAT_CHART_LOOK);
        expect(lookFields).toEqual(['seed']);
        expect(inserted.seed).toBeGreaterThanOrEqual(1);
        const again = author(workbook(), (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')));
        expect(again.next.sheets[0].charts!.c3.seed).not.toBe(inserted.seed);
        expect(readChartLook({ ...inserted, seed: FLAT_CHART_LOOK.seed })).toEqual(FLAT_CHART_LOOK);
    });

    test('a paste stores the look it came with', () => {
        const look = { ...FLAT_CHART_LOOK, roughness: 2, seed: 77, color: '#334455' };
        const { next } = author(workbook(), (ctx) => pasteChart(ctx, 'c3', SPEC, { width: 400, height: 300 }, look));
        expect(readChartLook(next.sheets[0].charts!.c3)).toEqual(look);
    });

    // The item carries one string; split into parts, each keyed one a record, it keeps every entry as it came.
    test('a paste stores the spec as it came, a part per field', () => {
        const sample = sampleChartSpec('pie');
        const spec = JSON.stringify({ ...sample, series: { ...sample.series, 's-9': { color: '#00ff00' } } });
        const { next } = author(workbook(), (ctx) => pasteChart(ctx, 'c3', spec, BOX, FLAT_CHART_LOOK));
        const pasted = next.sheets[0].charts!.c3;
        expect(readChartSpec(pasted).stored).toEqual(readChartSpec(spec).stored);
        expect(pasted.specPoints).toEqual({});
    });

    test('a look edit writes only the fields given, each its own op', () => {
        const { ops } = author(workbook(), (ctx) => setChartLook(ctx, 'c1', { roughness: 1, strokeColor: '#ff0000' }));
        expect(ops.map((op) => [op.op, op.path, op.value])).toEqual([
            ['add', ['charts', 'c1', 'roughness'], 1],
            ['add', ['charts', 'c1', 'strokeColor'], '#ff0000'],
        ]);
    });

    test('a viewer writes nothing', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.allowEdit = false;
        });
        for (const recipe of [
            (ctx: Context) => insertChart(ctx, 'c3', BOX, sampleChartSpec('line')),
            (ctx: Context) => setChartSpec(ctx, 'c1', [{ op: 'set', path: ['chart', 'type'], value: 'pie' }]),
            (ctx: Context) => setChartLook(ctx, 'c1', { roughness: 2 }),
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
            { undoList: [], redoList: [] },
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

describe('a chart edit keeps what this build does not know', () => {
    // c1 as a newer build stored it: a key on its chart part, one on an axis, a legend this build doesn't draw, and
    // keys on its data and its series.
    const newer = () =>
        produce(workbook(), (ctx: Context) => {
            const c1 = ctx.sheets[0].charts!.c1;
            const spec = rangeSpec(ref(S, [2, 5]));
            const series = spec.data.series.map((s) => ({ ...s, dash: 'dot' }));
            c1.specChart = JSON.stringify({ ...spec.chart, future: 1 });
            c1.specLegend = JSON.stringify({ position: 'inside' });
            c1.specAxes.y = JSON.stringify({ ...spec.axes.y, logBase: 10 });
            c1.specData = JSON.stringify({ ...spec.data, future: 2, series });
        });
    const part = (ctx: Context, key: 'specTitle' | 'specData') => JSON.parse(ctx.sheets[0].charts!.c1[key]);
    const kept = (ctx: Context) => {
        const { specChart, specLegend, specAxes } = ctx.sheets[0].charts!.c1;
        const data = part(ctx, 'specData');
        return [
            JSON.parse(specChart).future,
            JSON.parse(specLegend).position,
            JSON.parse(specAxes.y).logBase,
            data.future,
            data.series[0].dash,
        ];
    };
    const title: ChartSpecChange = [{ op: 'set', path: ['title', 'text'], value: 'Goals' }];

    test('a title through setChartSpec', () => {
        const { next } = author(newer(), (ctx) => setChartSpec(ctx, 'c1', title));
        expect(part(next, 'specTitle').text).toBe('Goals');
        expect(kept(next)).toEqual([1, 'inside', 10, 2, 'dot']);
    });

    test('a typed range, its first series keeping its id and the keys beside the data', () => {
        const known = produce(newer(), (ctx: Context) => {
            ctx.sheets[0].charts!.c1.specData = JSON.stringify(rangeSpec(ref(S, [2, 5])).data);
        });
        const { next } = author(known, (ctx) => setChartDataRange(ctx, 'c1', ref(S, [2, 5], [1, 2])));
        expect(rangeData(next.sheets, 0, 'c1')?.series.map((s) => s.values?.column)).toEqual([
            [1, 1],
            [2, 2],
        ]);
        expect(part(next, 'specData').series[0].id).toBe('s-1');
        expect(kept(next).slice(0, 3)).toEqual([1, 'inside', 10]);
    });

    // Rebuilt values would fall out of step with an array a newer build keeps beside them.
    test("a typed range writes nothing on data holding a key this build doesn't know", () => {
        const { ops } = author(newer(), (ctx) => setChartDataRange(ctx, 'c1', ref(S, [2, 5], [1, 2])));
        expect(ops).toEqual([]);
    });

    test('a row insert', () => {
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
        const { next } = author(newer(), (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(rangeData(next.sheets, 0, 'c1')?.series[0].values?.row).toEqual([4, 7]);
        expect(kept(next)).toEqual([1, 'inside', 10, 2, 'dot']);
    });

    // The panel hands a change, which the recipe applies onto the chart as it then stores it.
    test("a peer's colour landing after the panel rendered survives the panel's title", () => {
        const base = workbook();
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-1', 'color'], value: '#00ff00' }];
        const peer = author(base, (ctx) => setChartSpec(ctx, 'c1', recolor));
        const mine = author(receive(base, peer.ops), (ctx) => setChartSpec(ctx, 'c1', title));
        expect(readChartSpec(mine.next.sheets[0].charts!.c1).spec).toMatchObject({
            title: { text: 'Goals' },
            series: { 's-1': { color: '#00ff00' } },
        });
        expect(charts(join(base, [peer.ops, mine.ops]))).toEqual(charts(mine.next.sheets));
    });
});

describe('charts converge over real ops', () => {
    test('three clients editing different charts end identical, and so does a joiner', () => {
        const base = workbook();
        const a = author(base, (ctx) => insertChart(ctx, 'c3', BOX, sampleChartSpec('pie')));
        const b = author(base, (ctx) => updateFloatingBox(ctx, { kind: 'chart', id: 'c1' }, { x: 300, y: 40 }));
        const c = author(base, (ctx) => setChartSpec(ctx, 'c2', TO_LINE));
        const onA = receive(receive(a.next, b.ops), c.ops);
        const onB = receive(receive(b.next, c.ops), a.ops);
        const onC = receive(receive(c.next, a.ops), b.ops);
        const joiner = join(base, [b.ops, a.ops, c.ops]);
        expect(charts(onB.sheets)).toEqual(charts(onA.sheets));
        expect(charts(onC.sheets)).toEqual(charts(onA.sheets));
        expect(charts(joiner)).toEqual(charts(onA.sheets));
        expect(Object.keys(onA.sheets[0].charts!).sort()).toEqual(['c1', 'c2', 'c3']);
    });

    test("two look edits on one chart merge with a peer's move and spec edit, on every client and a joiner", () => {
        const base = workbook();
        const a = author(base, (ctx) => setChartLook(ctx, 'c1', { roughness: 2 }));
        const b = author(base, (ctx) => setChartLook(ctx, 'c1', { strokeWidth: 4 }));
        const c = author(base, (ctx) => updateFloatingBox(ctx, { kind: 'chart', id: 'c1' }, { x: 300 }));
        const d = author(base, (ctx) => setChartSpec(ctx, 'c1', TO_LINE));
        const all = [a, b, c, d];
        const clients = all.map((self) =>
            all.filter((other) => other !== self).reduce((ctx, other) => receive(ctx, other.ops), self.next),
        );
        const joiner = join(
            base,
            all.map(({ ops }) => ops),
        );
        for (const client of clients) expect(charts(client.sheets)).toEqual(charts(clients[0].sheets));
        expect(charts(joiner)).toEqual(charts(clients[0].sheets));
        expect(clients[0].sheets[0].charts!.c1).toMatchObject({
            roughness: 2,
            strokeWidth: 4,
            x: 300,
            specChart: JSON.stringify(asLine(rangeSpec(ref(S, [2, 5]))).chart),
        });
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

    // A row op writes a shifted chart's spec alone, so a peer's move or delete of that chart at once survives.
    test.each<[string, Op[], number[]]>([
        ['moves', [{ op: 'replace', id: T, path: ['charts', 't1', 'x'], value: 300 }], [300]],
        ['deletes', [{ op: 'remove', id: T, path: ['charts', 't1'] }], []],
    ])('a row insert racing a peer that %s a shifted chart ends identical everywhere', (_, peer, xs) => {
        const base = workbook();
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
        const insert = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        const onA = receive(insert.next, peer);
        const onB = receive(receive(base, peer), insert.ops);
        expect(Object.values(onA.sheets[1].charts!).map((c) => c.x)).toEqual(xs);
        expect(charts(onB.sheets)).toEqual(charts(onA.sheets));
        expect(charts(join(base, [insert.ops, peer]))).toEqual(charts(onA.sheets));
        expect(charts(join(base, [peer, insert.ops]))).toEqual(charts(onA.sheets));
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

    // Workbook's handleUndo and handleRedo, after a peer's edit: typing 42 in T!A1 and moving t1, or deleting t1.
    function undoRedoAfterPeer(base: Context, peerEdit: Op[]) {
        const del = { type: 'row', start: 3, end: 6, id: S } as const;
        const deleted = author(base, (ctx) => deleteRowCol(ctx, del), { deleteRowColOp: del });
        const afterPeer = receive(deleted.next, peerEdit);
        const inverse = withoutDeletedFloatingEdits(afterPeer, deleted.inverse);
        const undone = applyPatches(afterPeer, inverse);
        const undoOptions = { ...inverseRowColOptions({ deleteRowColOp: del }), restoreDeletedCells: true };
        const undoOps = patchToOp(undone, inverse, undoOptions, true);
        const patches = withoutDeletedFloatingEdits(undone, deleted.patches);
        const redone = applyPatches(undone, patches);
        const redoOps = patchToOp(redone, patches, { deleteRowColOp: del });
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
        expect([undo.author[1].charts!.t1.x, redo.author[1].charts!.t1.x]).toEqual([99, 99]);
    });

    test('undoing and redoing a row delete keeps a shifted chart a peer deleted deleted, on every client', () => {
        const { undo, redo } = undoRedoAfterPeer(workbook(), [{ op: 'remove', id: T, path: ['charts', 't1'] }]);
        for (const { author, peer, joiner } of [undo, redo]) {
            expect(author[1].charts!.t1).toBeUndefined();
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

// Every entry of a keyed part sits under its own key, so two peers editing two entries, or a part and an entry, keep
// both on every client and a joiner.
describe('two peers editing one chart keep both edits', () => {
    const set = (path: string[], value: unknown): ChartSpecChange => [{ op: 'set', path, value }];
    const title = set(['title', 'text'], 'Goals');
    const recolor = (index: number, color: string) => set(['points', 's-1', String(index)], { color });
    const spec = (sheets: Sheet[], id = 'c1') => readChartSpec(sheets[0].charts![id]).spec;
    const withChart = (id: string, value: ChartSpec) =>
        produce(workbook(), (ctx: Context) => {
            ctx.sheets[0].charts![id] = chart(id, value, 'a2');
        });

    // Both orders on both clients and a joiner end on one state.
    function converge(base: Context, a: ReturnType<typeof author>, b: ReturnType<typeof author>): Sheet[] {
        const onA = receive(a.next, b.ops);
        expect(charts(receive(b.next, a.ops).sheets)).toEqual(charts(onA.sheets));
        expect(charts(join(base, [a.ops, b.ops]))).toEqual(charts(onA.sheets));
        expect(charts(join(base, [b.ops, a.ops]))).toEqual(charts(onA.sheets));
        return onA.sheets;
    }

    test.each<[string, ChartSpecChange, ChartSpecChange, object]>([
        [
            'a title and a series colour',
            title,
            set(['series', 's-1', 'color'], '#00ff00'),
            { title: { text: 'Goals' }, series: { 's-1': { color: '#00ff00' } } },
        ],
        [
            "two series' colours",
            set(['series', 's-1', 'color'], '#ff0000'),
            set(['series', 's-2', 'color'], '#00ff00'),
            { series: { 's-1': { color: '#ff0000' }, 's-2': { color: '#00ff00' } } },
        ],
        [
            "the x axis's title and the y axis's min",
            set(['axes', 'x', 'title', 'text'], 'Month'),
            set(['axes', 'y', 'scale', 'min'], 10),
            { axes: { x: { title: { text: 'Month' } }, y: { scale: { min: 10 } } } },
        ],
        ['two slice colours', recolor(0, '#ff0000'), recolor(2, '#00ff00'), { points: { 's-1': { 0: {}, 2: {} } } }],
    ])('%s', (_, first, second, expected) => {
        const base = withChart('c3', sampleChartSpec('column'));
        const a = author(base, (ctx) => setChartSpec(ctx, 'c3', first));
        const b = author(base, (ctx) => setChartSpec(ctx, 'c3', second));
        expect(spec(converge(base, a, b), 'c3')).toMatchObject(expected);
    });

    // A new chart's points are a record from its insert, so each first slice colour ships as its entry alone.
    test("two peers' first slice colours of a new chart ship an entry each, and a joiner keeps both", () => {
        const inserted = author(workbook(), (ctx) => insertChart(ctx, 'p', BOX, sampleChartSpec('pie')));
        const base = inserted.next;
        const a = author(base, (ctx) => setChartSpec(ctx, 'p', recolor(0, '#ff0000')));
        const b = author(base, (ctx) => setChartSpec(ctx, 'p', recolor(2, '#00ff00')));
        expect(a.ops).toEqual([
            { op: 'add', id: S, path: ['charts', 'p', 'specPoints', 's-1/0'], value: '{"color":"#ff0000"}' },
        ]);
        const joiner = join(workbook(), [inserted.ops, a.ops, b.ops]);
        expect(readChartSpec(joiner[0].charts!.p).spec?.points).toEqual({
            's-1': { 0: { color: '#ff0000' }, 2: { color: '#00ff00' } },
        });
        expect(charts(converge(base, a, b))).toEqual(charts(joiner));
    });

    // c1's points run along its values, rows 2 to 5: the insert at row 4 moves point 3 to 4, the delete of row 3
    // removes point 1 and moves 3 to 2. Point 0, which a peer recolours, moves with neither.
    const slices = (): Context =>
        withChart('c1', {
            ...rangeSpec(ref(S, [2, 5])),
            points: { 's-1': { 1: { color: '#111111' }, 3: { color: '#333333' } } },
        });
    const insertOp = { type: 'row', index: 4, count: 1, direction: 'lefttop', id: S } as const;
    const deleteOp = { type: 'row', start: 3, end: 3, id: S } as const;
    const ROW_OPS = [
        {
            name: 'insert',
            run: (ctx: Context) => insertRowCol(ctx, insertOp),
            options: { insertRowColOp: insertOp },
            points: { 0: { color: '#ff0000' }, 1: { color: '#111111' }, 4: { color: '#333333' } },
        },
        {
            name: 'delete',
            run: (ctx: Context) => deleteRowCol(ctx, deleteOp),
            options: { deleteRowColOp: deleteOp },
            points: { 0: { color: '#ff0000' }, 2: { color: '#333333' } },
        },
    ] as const;
    const PEER_EDITS = [
        { name: 'title', change: title, kept: { title: { text: 'Goals' } } },
        {
            name: 'slice colour',
            change: recolor(0, '#ff0000'),
            kept: { points: { 's-1': { 0: { color: '#ff0000' } } } },
        },
    ] as const;

    for (const rowOp of ROW_OPS) {
        for (const edit of PEER_EDITS) {
            test(`a row ${rowOp.name} and a peer's ${edit.name}, landing before or after it`, () => {
                const base = slices();
                const op = author(base, rowOp.run, rowOp.options);
                const peer = author(base, (ctx) => setChartSpec(ctx, 'c1', [...edit.change]));
                const sheets = converge(base, op, peer);
                expect(spec(sheets)).toMatchObject(edit.kept);
                if (edit.name === 'slice colour') expect(spec(sheets)?.points['s-1']).toEqual(rowOp.points);
            });

            // Workbook's handleUndo and handleRedo after the peer's edit landed.
            test(`undoing and redoing a row ${rowOp.name} keeps a peer's ${edit.name}`, () => {
                const base = slices();
                const op = author(base, rowOp.run, rowOp.options);
                const peer = author(base, (ctx) => setChartSpec(ctx, 'c1', [...edit.change]));
                const afterPeer = receive(op.next, peer.ops);
                const inverse = withoutDeletedFloatingEdits(afterPeer, op.inverse);
                const undone = applyPatches(afterPeer, inverse);
                const undoOptions = { ...inverseRowColOptions(rowOp.options), restoreDeletedCells: true };
                const undoOps = patchToOp(undone, inverse, undoOptions, true);
                const patches = withoutDeletedFloatingEdits(undone, op.patches);
                const redone = applyPatches(undone, patches);
                const redoOps = patchToOp(redone, patches, rowOp.options);
                const peerUndone = receive(receive(peer.next, op.ops), undoOps);
                const joinUndone = join(base, [peer.ops, op.ops, undoOps]);
                expect(spec(undone.sheets)).toMatchObject(edit.kept);
                expect(spec(undone.sheets)?.points['s-1']).toMatchObject({
                    1: { color: '#111111' },
                    3: { color: '#333333' },
                });
                expect(charts(peerUndone.sheets)).toEqual(charts(undone.sheets));
                expect(charts(joinUndone)).toEqual(charts(undone.sheets));
                expect(spec(redone.sheets)).toMatchObject(edit.kept);
                expect(charts(receive(peerUndone, redoOps).sheets)).toEqual(charts(redone.sheets));
                expect(charts(join(base, [peer.ops, op.ops, undoOps, redoOps]))).toEqual(charts(redone.sheets));
            });
        }
    }
});

// Every read of a chart, a draw, the panel and a row op among them, goes through readChartSpec, whose byte count stops
// at the limit; a chart past the entry cap never reaches one, whichever door it came through.
describe('a forged chart costs a read what fits under the byte limit', () => {
    const forgedPoints = (count: number) =>
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`s-1/${i % 2000}-${i}`, '{"color":"#ff0000"}']));

    test('a draw and a row op read entries only up to the limit', () => {
        let visited = 0;
        const points = new Proxy(forgedPoints(20_000), {
            get: (target, key) => {
                visited += 1;
                return Reflect.get(target, key);
            },
        });
        const forged = { ...chart('f1', rangeSpec(ref(S, [2, 5]))), specPoints: points };
        const ctx = produce(workbook(), (draft: Context) => {
            draft.sheets[0].charts!.c1 = { ...draft.sheets[0].charts!.c1 };
        });
        sheetChartSvg(ctx, forged);
        expect(mapChartRefs(forged, (r) => ({ ...r, row: [r.row[0] + 1, r.row[1] + 1] }))).toBe(forged);
        expect(visited).toBeGreaterThan(0);
        expect(visited).toBeLessThan(2 * 4_000);
    });

    test('a snapshot or a replay base leaves out a chart past the entry cap', () => {
        const base = workbook();
        const forged = { ...chart('f1', rangeSpec(ref(S, [2, 5]))), specPoints: forgedPoints(MAX_CHART_SPEC_ENTRIES) };
        const sheets = structuredClone(base.sheets);
        sheets[0].charts!.f1 = forged;
        const decoded = decodeSheetsSnapshot(encodeSheetsSnapshot(sheets, { computed: true }));
        expect(Object.keys(decoded[0].charts!).sort()).toEqual(['c1', 'c2']);
        expect(Object.keys(replaySheetsOps(sheets, [])[0].charts!).sort()).toEqual(['c1', 'c2']);
    });
});
