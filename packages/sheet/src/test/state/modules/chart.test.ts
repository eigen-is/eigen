import { describe, expect, test } from 'bun:test';
import {
    CHART_MAX_SIDE,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    FLAT_CHART_LOOK,
    newChartSpecParts,
    readChartLook,
    readChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { Sheet as LibSheet, SheetChart } from '@workspace/lib/sheets';
import {
    decodeSheetsSnapshot,
    encodeSheetsSnapshot,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_ROW_HEIGHT,
} from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec, ChartSpecChange } from '@workspace/lib/types/chart';
import { enablePatches, produce } from 'immer';
import { generateAPIs } from '../../../components/Workbook/api';
import { replaySheetsOps } from '../../../engine';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Context } from '../../../state/context';
import {
    insertChart,
    pasteChart,
    setChartDataRange,
    setChartLook,
    setChartSpec,
    sheetChartClipboardItem,
    sheetChartSvg,
} from '../../../state/modules/chart';
import { updateFloatingBox } from '../../../state/modules/floating';
import { redoEntry, undoEntry } from '../../../state/modules/history';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import { addSheet, initSheetData } from '../../../state/modules/sheet';
import type { Op, Sheet } from '../../../state/types';
import { author, join, receive } from '../factories/collab';
import { contextFactory } from '../factories/context';

enablePatches();

const S = 'id_1';
const T = 'id_2';
const BOX = { x: 10, y: 20, width: 400, height: 300 };
const SPEC = newChartSpecParts(sampleChartSpec('column'));
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
    return { id, index, ...BOX, ...newChartSpecParts(spec) };
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

const charts = (sheets: LibSheet[]) => sheets.map((sheet) => sheet.charts);
const rangeData = (sheets: LibSheet[], sheet: number, id: string) => {
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

    test('a paste stores the parts as they came, a part the item lacks as empty', () => {
        const { specPoints, ...parts } = newChartSpecParts(sampleChartSpec('pie'));
        const fields = newChartSpecParts({ ...parts, specTitle: '{"text":' });
        const { next } = author(workbook(), (ctx) => pasteChart(ctx, 'c3', fields, BOX, FLAT_CHART_LOOK));
        expect(next.sheets[0].charts!.c3).toMatchObject({ ...parts, specTitle: '{"text":', specPoints: '' });
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
        const api = generateAPIs(
            () => next,
            setContext,
            () => {},
            () => {},
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
        initSheetData(ctx.sheets[0]);
        expect(ctx.sheets[0].charts).toEqual({});
        addSheet(ctx);
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
            c1.specAxes = JSON.stringify({ ...spec.axes, y: { ...spec.axes.y, logBase: 10 } });
            c1.specData = JSON.stringify({ ...spec.data, future: 2, series });
        });
    const part = (ctx: Context, key: 'specTitle' | 'specData') => JSON.parse(ctx.sheets[0].charts!.c1[key]);
    const kept = (ctx: Context) => {
        const { specChart, specLegend, specAxes } = ctx.sheets[0].charts!.c1;
        const data = part(ctx, 'specData');
        return [
            JSON.parse(specChart).future,
            JSON.parse(specLegend).position,
            JSON.parse(specAxes).y.logBase,
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

    // Every receiver's engine shifts the chart by the op itself. An author's write of the chart it shifted would land on
    // a receiver that also took a peer's insert, and leave the chart a row off there.
    test('two row inserts sent at once both shift a chart, on both authors and a joiner', () => {
        const base = workbook();
        const insert = (count: number) => {
            const op = { type: 'row', index: 0, count, direction: 'lefttop', id: S } as const;
            return author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        };
        const a = insert(2);
        const b = insert(1);
        const onA = receive(a.next, b.ops);
        const onB = receive(b.next, a.ops);
        for (const sheets of [onA.sheets, onB.sheets, join(base, [a.ops, b.ops])]) {
            expect(rangeData(sheets, 0, 'c1')?.series[0].values?.row).toEqual([5, 8]);
            expect(rangeData(sheets, 1, 't1')?.categories?.row).toEqual([6, 7]);
        }
    });

    // A row op ships no chart write, since every receiver shifts the chart, so a peer's move or delete of it survives.
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

        const { ctx: undone, ops: undoOps } = undoEntry(deleted.next, deleted.entry);

        const peer = receive(receive(base, deleted.ops), undoOps);
        const joiner = join(base, [deleted.ops, undoOps]);
        expect(charts(undone.sheets)).toEqual(charts(base.sheets));
        expect(charts(peer.sheets)).toEqual(charts(base.sheets));
        expect(charts(joiner)).toEqual(charts(base.sheets));
    });

    test('an undone row delete restores a chart on a sheet whose formula moved too, everywhere', () => {
        const base = workbook();
        base.sheets[1].data![9][3] = { f: '=SUM(S!B3:B6)', v: 0, m: '0' };
        const del = { type: 'row', start: 3, end: 6, id: S } as const;
        const deleted = author(base, (ctx) => deleteRowCol(ctx, del), { deleteRowColOp: del });
        const { ctx: undone, ops: undoOps } = undoEntry(deleted.next, deleted.entry);
        const { ctx: redone, ops: redoOps } = redoEntry(undone, deleted.entry);
        const peerUndone = receive(receive(base, deleted.ops), undoOps);
        expect(rangeData(undone.sheets, 1, 't1')).toEqual(rangeData(base.sheets, 1, 't1'));
        expect(charts(peerUndone.sheets)).toEqual(charts(undone.sheets));
        expect(charts(join(base, [deleted.ops, undoOps]))).toEqual(charts(undone.sheets));
        expect(charts(receive(peerUndone, redoOps).sheets)).toEqual(charts(redone.sheets));
        expect(charts(join(base, [deleted.ops, undoOps, redoOps]))).toEqual(charts(redone.sheets));
    });

    test('undoing a row insert restores a ref an insert stopped at the last row, on a sheet whose formula moved too', () => {
        const base = workbook();
        base.sheets[1].data![9][3] = { f: '=SUM(S!B3:B6)', v: 0, m: '0' };
        base.sheets[1].charts!.t1 = chart('t1', rangeSpec(ref(S, [1, 1048575])));
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
        const insert = author(base, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(rangeData(insert.next.sheets, 1, 't1')?.series[0].values?.row).toEqual([3, 1048575]);
        const { ctx: undone, ops: undoOps } = undoEntry(insert.next, insert.entry);
        const peer = receive(receive(base, insert.ops), undoOps);
        const joiner = join(base, [insert.ops, undoOps]);
        expect(charts(undone.sheets)).toEqual(charts(base.sheets));
        expect(charts(peer.sheets)).toEqual(charts(base.sheets));
        expect(charts(joiner)).toEqual(charts(base.sheets));
    });
});

// Each part is its own field, so two peers editing two parts of one chart keep both.
describe('two peers editing two parts of one chart keep both edits', () => {
    const set = (path: string[], value: unknown): ChartSpecChange => [{ op: 'set', path, value }];
    const title = set(['title', 'text'], 'Goals');
    const recolor = (index: number, color: string) => set(['points', 's-1', String(index)], { color });
    const spec = (sheets: LibSheet[], id = 'c1') => readChartSpec(sheets[0].charts![id]).spec;
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
            'a series colour and a slice colour',
            set(['series', 's-1', 'color'], '#ff0000'),
            recolor(2, '#00ff00'),
            { series: { 's-1': { color: '#ff0000' } }, points: { 's-1': { 2: { color: '#00ff00' } } } },
        ],
        [
            "the x axis's title and a column chart's stacking",
            set(['axes', 'x', 'title', 'text'], 'Month'),
            set(['plots', 'column', 'stacking'], 'stacked'),
            { axes: { x: { title: { text: 'Month' } } }, plots: { column: { stacking: 'stacked' } } },
        ],
    ])('%s', (_, first, second, expected) => {
        const base = withChart('c3', sampleChartSpec('column'));
        const a = author(base, (ctx) => setChartSpec(ctx, 'c3', first));
        const b = author(base, (ctx) => setChartSpec(ctx, 'c3', second));
        expect(spec(converge(base, a, b), 'c3')).toMatchObject(expected);
    });

    // c1's points run along its values, rows 2 to 5. Both ops land inside them and leave every point at its index.
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
        },
        {
            name: 'delete',
            run: (ctx: Context) => deleteRowCol(ctx, deleteOp),
            options: { deleteRowColOp: deleteOp },
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
                if (edit.name === 'slice colour') {
                    expect(spec(sheets)?.points['s-1']).toEqual({
                        0: { color: '#ff0000' },
                        1: { color: '#111111' },
                        3: { color: '#333333' },
                    });
                }
            });
        }
    }
});

// A sheet's chart holds the eight JSON strings a canvas element and a doc's node hold, so one codec reads and writes all.
describe('a sheet chart stores each part as one string', () => {
    const set = (path: string[], value: unknown): ChartSpecChange => [{ op: 'set', path, value }];
    const sample = sampleChartSpec('column');
    const withChart = (patch: Record<string, unknown> = {}) =>
        produce(workbook(), (ctx: Context) => {
            const stored: SheetChart = { id: 'c3', index: 'a2', ...BOX, ...newChartSpecParts(sample) };
            ctx.sheets[0].charts!.c3 = Object.assign(stored, patch);
        });
    const c3 = (sheets: LibSheet[]) => sheets[0].charts!.c3;

    test('a restyle is one replace of the part it changed', () => {
        const { ops, next } = author(withChart(), (ctx) =>
            setChartSpec(ctx, 'c3', set(['series', 's-1', 'color'], '#00ff00')),
        );
        const series = JSON.stringify({ ...sample.series, 's-1': { ...sample.series['s-1'], color: '#00ff00' } });
        expect(ops).toEqual([{ op: 'replace', id: S, path: ['charts', 'c3', 'specSeries'], value: series }]);
        expect(c3(next.sheets).specSeries).toBe(series);
    });

    test("a peer's write of a part lands whole, and of two on one part the later one stands", () => {
        const base = withChart();
        const a = author(base, (ctx) => setChartSpec(ctx, 'c3', set(['series', 's-1', 'color'], '#ff0000')));
        const b = author(base, (ctx) => setChartSpec(ctx, 'c3', set(['series', 's-2', 'color'], '#00ff00')));
        expect(charts(receive(base, a.ops).sheets)).toEqual(charts(a.next.sheets));
        const joined = join(base, [a.ops, b.ops]);
        expect(c3(joined).specSeries).toBe(c3(b.next.sheets).specSeries);
        expect(readChartSpec(c3(joined)).spec?.series).toMatchObject({
            's-1': { color: null },
            's-2': { color: '#00ff00' },
        });
    });

    test("an edit of a part keeps the keys in it this build doesn't know", () => {
        const specAxes = JSON.stringify({ ...sample.axes, y: { ...sample.axes.y, logBase: 10 }, y9: { future: 1 } });
        const { next } = author(withChart({ specAxes }), (ctx) =>
            setChartSpec(ctx, 'c3', set(['axes', 'y', 'scale', 'min'], 5)),
        );
        const axes = JSON.parse(c3(next.sheets).specAxes);
        expect([axes.y.scale.min, axes.y.logBase, axes.y9]).toEqual([5, 10, { future: 1 }]);
    });

    // What a build before this one stored: a record of entries where a part is now a string.
    test('a part stored as a record of entries reads its defaults, the chart draws, and an edit stores a string', () => {
        const records = {
            specAxes: { y: JSON.stringify({ ...sample.axes.y, title: { text: 'Old axis' } }) },
            specPlots: { column: JSON.stringify({ stacking: 'stacked' }) },
            specSeries: { 's-1': JSON.stringify({ ...sample.series['s-1'], color: '#ff0000' }) },
            specPoints: { 's-1/0': JSON.stringify({ color: '#00ff00' }) },
        };
        const base = withChart(records);
        const defaults = defaultChartSpec('column', sample.data);
        expect(readChartSpec(c3(base.sheets)).spec).toEqual({
            ...sample,
            axes: defaults.axes,
            plots: defaults.plots,
            series: defaults.series,
            points: {},
        });
        const svg = sheetChartSvg(base, c3(base.sheets));
        expect(svg).toContain('Hot star');
        expect(svg).not.toContain('Old axis');
        expect(svg).not.toContain("can't be shown");
        const { ops } = author(base, (ctx) => setChartSpec(ctx, 'c3', set(['axes', 'y', 'title', 'text'], 'New')));
        expect(ops).toEqual([
            {
                op: 'replace',
                id: S,
                path: ['charts', 'c3', 'specAxes'],
                value: JSON.stringify({ y: { title: { text: 'New' } } }),
            },
        ]);
    });

    test('a copy to another app carries the eight parts as stored, and no ninth key', () => {
        const specAxes = JSON.stringify({ ...sample.axes, y: { ...sample.axes.y, logBase: 10 } });
        const base = withChart({ specAxes, specFuture: '{"forged":1}' });
        const item = sheetChartClipboardItem(base, c3(base.sheets));
        expect(item?.parts).toEqual({ ...newChartSpecParts(sample), specAxes });
    });
});
