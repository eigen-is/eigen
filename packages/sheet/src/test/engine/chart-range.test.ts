import { describe, expect, test } from 'bun:test';
import { MAX_CHART_POINTS, parseChartSpec } from '@workspace/lib/charts';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { createArrayResolver } from '../../engine/cell-resolver';
import type { ChartRange } from '../../engine/chart-range';
import {
    chartRangeData,
    chartRangeOf,
    chartRangeText,
    currentRegion,
    parseChartRangeText,
    suggestChartRange,
    suggestChartSpec,
} from '../../engine/chart-range';
import type { Cell, CellResolver } from '../../engine/types';

const ref = (row: [number, number], column: [number, number], sheetId = 's1'): CellRangeRef => ({
    sheetId,
    row,
    column,
});

const text = (value: string): Cell => ({ v: value, m: value });
const num = (value: number): Cell => ({ v: value, m: String(value), ct: { fa: 'General', t: 'n' } });

//      A        B        C        D
// 1    Month    North    South    East
// 2    Jan      10       20       30
// 3    Feb      11       21       31
// 4    Mar      12       22       32
const table: (Cell | null)[][] = [
    [text('Month'), text('North'), text('South'), text('East')],
    [text('Jan'), num(10), num(20), num(30)],
    [text('Feb'), num(11), num(21), num(31)],
    [text('Mar'), num(12), num(22), num(32)],
];

// Two rows of twelve: the rows are longer than the columns.
const wide: (Cell | null)[][] = [
    [text('Year'), ...Array.from({ length: 6 }, (_, i) => text(`M${i + 1}`))],
    [text('Sales'), ...Array.from({ length: 6 }, (_, i) => num(i))],
];

const numbers: (Cell | null)[][] = [
    [num(1), num(2)],
    [num(3), num(4)],
    [num(5), num(6)],
];

const resolver = createArrayResolver([
    { id: 's1', name: 'Sheet1', data: table, calculationChain: [], dynamicArrayCompute: [] },
    { id: 's2', name: 'Wide sheet', data: wide, calculationChain: [], dynamicArrayCompute: [] },
    { id: 's3', name: "Bob's", data: numbers, calculationChain: [], dynamicArrayCompute: [] },
]);
const sheets = resolver.getSheets();

describe('suggestChartRange', () => {
    test('a text first row names series, a text first column names categories, series run down columns', () => {
        expect(suggestChartRange(ref([0, 3], [0, 3]), resolver)).toEqual({
            ref: ref([0, 3], [0, 3]),
            seriesInRows: false,
            headerRow: true,
            headerColumn: true,
        });
    });

    test('series run along the rows when the rows are longer', () => {
        expect(suggestChartRange(ref([0, 1], [0, 6], 's2'), resolver)).toMatchObject({
            seriesInRows: true,
            headerRow: true,
            headerColumn: true,
        });
    });

    test('a block of numbers has no headers', () => {
        expect(suggestChartRange(ref([0, 2], [0, 1], 's3'), resolver)).toMatchObject({
            seriesInRows: false,
            headerRow: false,
            headerColumn: false,
        });
    });

    test('the corner cell alone does not make a header row', () => {
        // A2:C4: its corner, Jan, is text, the rest of its first row numbers.
        expect(suggestChartRange(ref([1, 3], [0, 2], 's1'), resolver)).toMatchObject({
            headerRow: false,
            headerColumn: true,
        });
    });
});

describe('chartRangeData', () => {
    const range: ChartRange = { ref: ref([0, 3], [0, 3]), seriesInRows: false, headerRow: true, headerColumn: true };

    test('columns: a series per column named by its header, categories down the first column', () => {
        const data = chartRangeData(range);
        expect(data?.categories).toEqual(ref([1, 3], [0, 0]));
        expect(data?.series.map(({ name, values }) => ({ name, values }))).toEqual([
            { name: ref([0, 0], [1, 1]), values: ref([1, 3], [1, 1]) },
            { name: ref([0, 0], [2, 2]), values: ref([1, 3], [2, 2]) },
            { name: ref([0, 0], [3, 3]), values: ref([1, 3], [3, 3]) },
        ]);
    });

    test('switching rows and columns makes a series per row, named by the first column', () => {
        const data = chartRangeData({ ...range, seriesInRows: true });
        expect(data?.categories).toEqual(ref([0, 0], [1, 3]));
        expect(data?.series.map(({ name, values }) => ({ name, values }))).toEqual([
            { name: ref([1, 1], [0, 0]), values: ref([1, 1], [1, 3]) },
            { name: ref([2, 2], [0, 0]), values: ref([2, 2], [1, 3]) },
            { name: ref([3, 3], [0, 0]), values: ref([3, 3], [1, 3]) },
        ]);
    });

    test('without headers the series are unnamed and the categories counted', () => {
        const data = chartRangeData({ ...range, headerRow: false, headerColumn: false });
        expect(data?.categories).toBeNull();
        expect(data?.series).toHaveLength(4);
        expect(data?.series[0]).toMatchObject({ name: '', values: ref([0, 3], [0, 0]) });
    });

    test("keeps the previous data's series ids and styles by index, and a series past them is new and automatic", () => {
        const previous = chartRangeData({ ...range, ref: ref([0, 3], [0, 1]) });
        if (!previous) throw new Error('no data');
        const kept = { ...previous.series[0], id: 's-kept', color: '#000000', markers: true };
        const data = chartRangeData(range, { ...previous, series: [kept] });
        expect(data?.series[0]).toMatchObject({ id: 's-kept', color: '#000000', markers: true });
        expect(data?.series[1]).toMatchObject({ color: null, markers: false });
        expect(data?.series.map(({ id }) => id.startsWith('s-'))).toEqual([true, true, true]);
        expect(new Set(data?.series.map(({ id }) => id)).size).toBe(3);
    });

    test('a block set up again keeps its series ids by index', () => {
        const before = chartRangeData(range);
        const after = chartRangeData({ ...range, seriesInRows: true }, before ?? undefined);
        expect(after?.series.map(({ id }) => id)).toEqual(before?.series.map(({ id }) => id));
    });

    test('a range with no values or more series than a chart holds has no data', () => {
        expect(chartRangeData({ ...range, ref: ref([0, 0], [0, 3]) })).toBeNull();
        expect(chartRangeData({ ...range, ref: ref([0, 3], [0, 40]) })).toBeNull();
    });
});

describe('chartRangeOf', () => {
    test('reads back the range and setup its data was derived from', () => {
        for (const range of [
            { ref: ref([0, 3], [0, 3]), seriesInRows: false, headerRow: true, headerColumn: true },
            { ref: ref([0, 3], [0, 3]), seriesInRows: true, headerRow: true, headerColumn: false },
            { ref: ref([2, 9], [1, 1]), seriesInRows: false, headerRow: false, headerColumn: false },
        ]) {
            const data = chartRangeData(range);
            if (!data) throw new Error('no data');
            expect(chartRangeOf(data)).toEqual(range);
        }
    });

    test('refs that no block derives have no range', () => {
        const data = chartRangeData({
            ref: ref([0, 3], [0, 3]),
            seriesInRows: false,
            headerRow: true,
            headerColumn: true,
        });
        if (!data) throw new Error('no data');
        expect(chartRangeOf({ ...data, series: [data.series[0], data.series[2]] })).toBeNull();
        expect(chartRangeOf({ ...data, series: [{ ...data.series[0], values: null }] })).toBeNull();
    });
});

describe('the data range as A1 text', () => {
    test('names the sheet only when it is not the chart’s own, quoted when it has to be', () => {
        expect(chartRangeText(ref([0, 3], [0, 3]), sheets, 's1')).toBe('A1:D4');
        expect(chartRangeText(ref([0, 1], [0, 6], 's2'), sheets, 's1')).toBe("'Wide sheet'!A1:G2");
        expect(chartRangeText(ref([1, 1], [1, 1], 's3'), sheets, 's1')).toBe("'Bob''s'!B2");
        expect(chartRangeText(ref([0, 0], [0, 0], 's1'), sheets, 's2')).toBe('Sheet1!A1');
    });

    test('parses to a ref by sheet id, on the chart’s own sheet when unqualified', () => {
        expect(parseChartRangeText(' A1:D4 ', sheets, 's1')).toEqual(ref([0, 3], [0, 3]));
        expect(parseChartRangeText('D4:A1', sheets, 's1')).toEqual(ref([0, 3], [0, 3]));
        expect(parseChartRangeText("'Wide sheet'!A1:G2", sheets, 's1')).toEqual(ref([0, 1], [0, 6], 's2'));
        expect(parseChartRangeText("'Bob''s'!B2", sheets, 's1')).toEqual(ref([1, 1], [1, 1], 's3'));
    });

    test('refuses text that is no range, a missing sheet and a range past the grid', () => {
        expect(parseChartRangeText('', sheets, 's1')).toBeNull();
        expect(parseChartRangeText('North', sheets, 's1')).toBeNull();
        expect(parseChartRangeText('Nowhere!A1:B2', sheets, 's1')).toBeNull();
        expect(parseChartRangeText('A1:A9999999', sheets, 's1')).toBeNull();
    });
});

describe('suggestChartSpec', () => {
    test('a column chart titled after its series, the corner cell naming the horizontal axis', () => {
        const spec = suggestChartSpec(ref([0, 3], [0, 3]), resolver);
        if (typeof spec === 'string') throw new Error(spec);
        expect(spec).toMatchObject({
            type: 'column',
            title: 'North, South and East',
            categoryAxis: { title: 'Month' },
        });
        // What is stored must read back.
        expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
    });

    test('the series store no color, so they draw in the palette as it is, in Inter', () => {
        const spec = suggestChartSpec(ref([0, 3], [0, 3]), resolver);
        if (typeof spec === 'string') throw new Error(spec);
        expect(spec.data.series.map((series) => series.color)).toEqual([null, null, null]);
        expect(spec.fontFamily).toBe('Inter');
    });

    test("starts from the default look, not Insert → Chart's sample, so no sample axis title carries over", () => {
        const spec = suggestChartSpec(ref([0, 3], [0, 3]), resolver);
        if (typeof spec === 'string') throw new Error(spec);
        expect(spec.valueAxis).toEqual({
            title: '',
            min: null,
            max: null,
            gridlines: true,
            format: null,
            visible: true,
        });
    });

    test('one or two series titles read naturally, unnamed series leave it empty', () => {
        expect(suggestChartSpec(ref([0, 3], [0, 1]), resolver)).toMatchObject({ title: 'North' });
        expect(suggestChartSpec(ref([0, 3], [0, 2]), resolver)).toMatchObject({ title: 'North and South' });
        expect(suggestChartSpec(ref([0, 2], [0, 1], 's3'), resolver)).toMatchObject({ title: '' });
    });

    test('more series than a chart holds is refused', () => {
        const many: (Cell | null)[][] = [Array.from({ length: 40 }, (_, i) => num(i))];
        const wideResolver = createArrayResolver([
            { id: 'w', name: 'W', data: many, calculationChain: [], dynamicArrayCompute: [] },
        ]);
        // One row of 40: the row is longer, so 1 series of 40 points.
        expect(suggestChartSpec(ref([0, 0], [0, 39], 'w'), wideResolver)).toMatchObject({ data: { series: [{}] } });
        const square = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => num(1)));
        const squareResolver = createArrayResolver([
            { id: 'q', name: 'Q', data: square, calculationChain: [], dynamicArrayCompute: [] },
        ]);
        expect(suggestChartSpec(ref([0, 39], [0, 39], 'q'), squareResolver)).toBe('too-many-series');
    });
});

describe('currentRegion', () => {
    test('a single cell grows to the block of filled cells around it', () => {
        expect(currentRegion(ref([2, 2], [2, 2]), resolver)).toEqual(ref([0, 3], [0, 3]));
    });

    test('a range is kept as selected', () => {
        expect(currentRegion(ref([1, 2], [1, 2]), resolver)).toEqual(ref([1, 2], [1, 2]));
    });

    test('an empty cell stays itself', () => {
        expect(currentRegion(ref([8, 8], [8, 8]), resolver)).toEqual(ref([8, 8], [8, 8]));
    });

    test('a 10,000-row table stops growing past the values a chart draws, in linear reads', () => {
        const rows = Array.from({ length: 10_000 }, (_, r) => Array.from({ length: 5 }, (_, c) => num(r * c)));
        const tall = createArrayResolver([
            { id: 't', name: 'Tall', data: rows, calculationChain: [], dynamicArrayCompute: [] },
        ]);
        let reads = 0;
        const counted: CellResolver = {
            ...tall,
            getCell: (sheetId, row, column) => {
                reads += 1;
                return tall.getCell(sheetId, row, column);
            },
        };
        const region = currentRegion(ref([3, 3], [2, 2], 't'), counted);
        expect(suggestChartSpec(region, counted)).toBe('too-many-points');
        expect(reads).toBeLessThan(4 * MAX_CHART_POINTS);
    });
});
