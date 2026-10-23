// Insert → Chart from the selection, and the data range writes the chart panel makes.
import { expect, test } from 'bun:test';
import { parseChartSpec } from '@workspace/lib/charts';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { produce } from 'immer';
import type { ChartRangeRefusal } from '../../../engine/chart-range';
import type { Cell } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { insertChartFromSelection, setChartDataRange } from '../../../state/modules/chart';
import { contextFactory } from '../factories/context';

const text = (v: string): Cell => ({ v, m: v });
const num = (v: number): Cell => ({ v, m: String(v) });

//      A        B        C        D
// 1    Month    North    South    East
// 2    Jan      10       20       30
// 3    Feb      11       21       31
// 4    Mar      12       22       32
// 5    Apr      13       23       33
// 6    (empty)
const months: (Cell | null)[][] = [
    [text('Month'), text('North'), text('South'), text('East')],
    [text('Jan'), num(10), num(20), num(30)],
    [text('Feb'), num(11), num(21), num(31)],
    [text('Mar'), num(12), num(22), num(32)],
    [text('Apr'), num(13), num(23), num(33)],
    [null, null, null, null],
];

function workbook(
    selection: { row: [number, number]; column: [number, number] },
    allowEdit = true,
    data = months,
): Context {
    const base = contextFactory({ allowEdit, selections: [{ ...selection, row_focus: 0, column_focus: 0 }] });
    const [first, ...rest] = base.sheets ?? [];
    return { ...base, sheets: [{ ...first, data, charts: {} }, ...rest] } as Context;
}

// A header row over `rows` rows of `columns` numbers.
const grid = (rows: number, columns: number): (Cell | null)[][] => [
    Array.from({ length: columns }, (_, c) => text(`S${c}`)),
    ...Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => num(r + c))),
];

const ref = (row: [number, number], column: [number, number]): CellRangeRef => ({ sheetId: 'id_1', row, column });

function insert(ctx: Context) {
    let refused: ChartRangeRefusal | undefined;
    const next = produce(ctx, (draft: Context) => {
        refused = insertChartFromSelection(draft, 'new');
    });
    return { refused, next, chart: next.sheets[0].charts?.new };
}

test('charts the selection below itself at Google’s size, selected', () => {
    const { refused, next, chart } = insert(workbook({ row: [0, 4], column: [0, 3] }));
    expect(refused).toBeUndefined();
    // A1 is the left edge, the bottom of row 5 the top (visibledatarow is the bottom of each row).
    expect(chart).toMatchObject({ x: 0, y: 100, width: 600, height: 371 });
    expect(next.activeObject).toEqual({ kind: 'chart', id: 'new' });
    const spec = parseChartSpec(chart?.spec ?? '');
    expect(spec).toMatchObject({ type: 'column', title: 'North, South and East', categoryAxis: { title: 'Month' } });
    expect(spec?.data).toMatchObject({
        source: 'range',
        categories: ref([1, 4], [0, 0]),
        series: [
            { name: ref([0, 0], [1, 1]), values: ref([1, 4], [1, 1]) },
            { name: ref([0, 0], [2, 2]), values: ref([1, 4], [2, 2]) },
            { name: ref([0, 0], [3, 3]), values: ref([1, 4], [3, 3]) },
        ],
    });
});

test('a single selected cell charts the table around it', () => {
    const { chart } = insert(workbook({ row: [1, 1], column: [2, 2] }));
    expect(parseChartSpec(chart?.spec ?? '')?.data).toMatchObject({ categories: ref([1, 4], [0, 0]) });
    expect(chart?.y).toBe(100);
});

test('a viewer inserts nothing', () => {
    const { chart } = insert(workbook({ row: [0, 4], column: [0, 3] }, false));
    expect(chart).toBeUndefined();
});

test('the new chart takes the selection from a selected image', () => {
    const { next } = insert({
        ...workbook({ row: [0, 4], column: [0, 3] }),
        activeObject: { kind: 'image', id: 'img' },
    });
    expect(next.activeObject).toEqual({ kind: 'chart', id: 'new' });
});

test('a selection or a table around one cell past the values a chart draws is refused as too much data', () => {
    const tall = grid(2100, 2);
    expect(insert(workbook({ row: [0, 2100], column: [0, 1] }, true, tall))).toMatchObject({
        refused: 'too-many-points',
        chart: undefined,
    });
    expect(insert(workbook({ row: [5, 5], column: [1, 1] }, true, tall))).toMatchObject({
        refused: 'too-many-points',
        chart: undefined,
    });
});

test('more series than a chart holds is refused as too many series', () => {
    expect(insert(workbook({ row: [0, 40], column: [0, 39] }, true, grid(40, 40)))).toMatchObject({
        refused: 'too-many-series',
        chart: undefined,
    });
});

test('a typed data range is set up from its cells and keeps each series’ color', () => {
    const { next } = insert(workbook({ row: [0, 4], column: [0, 3] }));
    const recolored = produce(next, (draft: Context) => {
        const spec = parseChartSpec(draft.sheets[0].charts?.new.spec ?? '');
        if (spec?.data.source !== 'range') throw new Error('no range chart');
        spec.data.series[0].color = '#000000';
        if (draft.sheets[0].charts) draft.sheets[0].charts.new.spec = JSON.stringify(spec);
    });
    const ranged = produce(recolored, (draft: Context) => setChartDataRange(draft, 'new', ref([0, 4], [0, 1])));
    const spec = parseChartSpec(ranged.sheets[0].charts?.new.spec ?? '');
    expect(spec?.title).toBe('North, South and East');
    expect(spec?.data).toMatchObject({
        categories: ref([1, 4], [0, 0]),
        series: [{ name: ref([0, 0], [1, 1]), values: ref([1, 4], [1, 1]), color: '#000000' }],
    });
});
