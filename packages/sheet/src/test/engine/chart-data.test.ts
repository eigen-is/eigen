import { describe, expect, test } from 'bun:test';
import { chartColor, MAX_CHART_LABEL_LENGTH, MAX_CHART_POINTS, sampleChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, RangeChartData, RangeChartSeries } from '@workspace/lib/types/chart';
import { createArrayResolver } from '../../engine/cell-resolver';
import { renderSheetChartSvg, resolveRangeChartData } from '../../engine/chart-data';
import type { Cell } from '../../engine/types';

const STYLE = { color: '#2a78d6', markers: false, smooth: false };

const ref = (row: [number, number], column: [number, number], sheetId = 's1'): CellRangeRef => ({
    sheetId,
    row,
    column,
});

const series = (values: CellRangeRef | null, name: string | CellRangeRef = 'Points'): RangeChartSeries => ({
    ...STYLE,
    name,
    values,
});

const data = (categories: CellRangeRef | null, ...list: RangeChartSeries[]): RangeChartData => ({
    source: 'range',
    categories,
    series: list,
});

//      A          B           C
// 1    Team       Points      Goals
// 2    Ajax       42          3
// 3    PSV        text        '1,000'
// 4    (empty)    (empty)     7
const cells: (Cell | null)[][] = [
    [{ v: 'Team', m: 'Team' }, { v: 'Points', m: 'Points' }, { v: 'Goals' }],
    [
        { v: 'Ajax', m: 'Ajax' },
        { v: 42, m: '42' },
        { v: 3, m: '3' },
    ],
    [
        { v: 'PSV', m: 'PSV' },
        { v: 'text', m: 'text' },
        { v: 1000, m: '1,000' },
    ],
    [null, null, { v: 7, m: '7' }],
];
const resolver = createArrayResolver([
    { id: 's1', name: 'Sheet1', data: cells, calculationChain: [], dynamicArrayCompute: [] },
]);

describe('resolveRangeChartData', () => {
    test('reads numbers from v, anything else as a gap, labels and names from the display text', () => {
        expect(
            resolveRangeChartData(
                data(
                    ref([1, 3], [0, 0]),
                    series(ref([1, 3], [1, 1]), ref([0, 0], [1, 1])),
                    series(ref([1, 3], [2, 2])),
                ),
                resolver,
            ),
        ).toEqual({
            categories: ['Ajax', 'PSV', ''],
            series: [
                { ...STYLE, name: 'Points', values: [42, null, null] },
                { ...STYLE, name: 'Points', values: [3, 1000, 7] },
            ],
        });
    });

    test('a label without a display string falls back to its value', () => {
        const resolved = resolveRangeChartData(data(ref([0, 0], [2, 2]), series(ref([1, 1], [2, 2]))), resolver);
        expect(resolved).toMatchObject({ categories: ['Goals'] });
    });

    test('a row ref reads across, and null categories count 1, 2, … to the longest series', () => {
        expect(
            resolveRangeChartData(data(null, series(ref([3, 3], [1, 2])), series(ref([1, 1], [1, 1]))), resolver),
        ).toEqual({
            categories: ['1', '2'],
            series: [
                { ...STYLE, name: 'Points', values: [null, 7] },
                { ...STYLE, name: 'Points', values: [42] },
            ],
        });
    });

    test('a rich-text label or name reads the text of its runs', () => {
        const rich = (...runs: string[]): Cell => ({ ct: { t: 'inlineStr', s: runs.map((v) => ({ v, bl: 1 })) } });
        const richResolver = createArrayResolver([
            {
                id: 's1',
                name: 'Sheet1',
                data: [[rich('Team ', 'A'), rich('Points')]],
                calculationChain: [],
                dynamicArrayCompute: [],
            },
        ]);
        const resolved = resolveRangeChartData(
            data(ref([0, 0], [0, 0]), series(ref([0, 0], [1, 1]), ref([0, 0], [1, 1]))),
            richResolver,
        );
        expect(resolved).toMatchObject({ categories: ['Team A'], series: [{ name: 'Points' }] });
    });

    test('a long label is cut to the label limit', () => {
        const long = createArrayResolver([
            {
                id: 's1',
                name: 'Sheet1',
                data: [[{ v: 'x'.repeat(500) }]],
                calculationChain: [],
                dynamicArrayCompute: [],
            },
        ]);
        const resolved = resolveRangeChartData(data(ref([0, 0], [0, 0]), series(ref([0, 0], [0, 0]))), long);
        expect(resolved).toMatchObject({ categories: ['x'.repeat(MAX_CHART_LABEL_LENGTH)] });
    });

    test('a series whose values were deleted is left out, and the rest keep their own colors', () => {
        const red = { ...series(ref([1, 3], [2, 2]), ref([0, 0], [2, 2])), color: '#ff0000' };
        expect(resolveRangeChartData(data(ref([1, 3], [0, 0]), series(null), red), resolver)).toEqual({
            categories: ['Ajax', 'PSV', ''],
            series: [{ ...STYLE, color: '#ff0000', name: 'Goals', values: [3, 1000, 7] }],
        });
    });

    // The editor shows a series' automatic color by its index in the spec, so the chart must too.
    test('an automatic color is the palette color at the series index in the spec, a deleted one before it kept', () => {
        const automatic = (values: CellRangeRef | null) => ({ ...series(values), color: null });
        const resolved = resolveRangeChartData(
            data(null, automatic(ref([1, 3], [1, 1])), automatic(null), automatic(ref([1, 3], [2, 2]))),
            resolver,
        );
        if (typeof resolved === 'string') throw new Error(resolved);
        expect(resolved.series.map((s) => s.color)).toEqual([chartColor(0), chartColor(2)]);
    });

    test('a ref spanning rows and columns, no series left or a ref to a missing sheet is a ref error', () => {
        expect(resolveRangeChartData(data(null, series(ref([1, 2], [1, 2]))), resolver)).toBe('ref');
        expect(resolveRangeChartData(data(ref([1, 2], [0, 1]), series(ref([1, 2], [1, 1]))), resolver)).toBe('ref');
        expect(resolveRangeChartData(data(null, series(null)), resolver)).toBe('ref');
        expect(resolveRangeChartData(data(null, series(ref([1, 2], [1, 1], 'gone'))), resolver)).toBe('ref');
        expect(resolveRangeChartData(data(ref([1, 2], [0, 0], 'gone'), series(ref([1, 2], [1, 1]))), resolver)).toBe(
            'ref',
        );
        expect(
            resolveRangeChartData(data(null, series(ref([1, 2], [1, 1]), ref([0, 0], [0, 0], 'gone'))), resolver),
        ).toBe('ref');
    });

    test('more points than the limit is its own state, before a cell is read', () => {
        const half = Math.floor(MAX_CHART_POINTS / 2);
        const column = (c: number) => ref([0, half], [c, c]);
        expect(resolveRangeChartData(data(null, series(column(0)), series(column(1))), resolver)).toBe(
            'too-many-points',
        );
        expect(resolveRangeChartData(data(ref([0, MAX_CHART_POINTS], [0, 0]), series(column(0))), resolver)).toBe(
            'too-many-points',
        );
        const atLimit = data(null, series(ref([0, half - 1], [0, 0])), series(ref([0, half - 1], [1, 1])));
        expect(resolveRangeChartData(atLimit, resolver)).not.toBeString();
    });
});

describe('renderSheetChartSvg', () => {
    const percent = (v: number): Cell => ({ v, m: `${v * 100}%`, ct: { fa: '0%', t: 'n' } });
    const shares = createArrayResolver([
        {
            id: 's1',
            name: 'Sheet1',
            data: [
                [{ v: 'Ajax', m: 'Ajax' }, percent(0.25)],
                [{ v: 'PSV', m: 'PSV' }, percent(0.5)],
            ],
            calculationChain: [],
            dynamicArrayCompute: [],
        },
    ]);
    const chart = (format: string | null): SheetChart => {
        const spec = sampleChartSpec('column');
        return {
            id: 'c1',
            index: 'a0',
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            spec: JSON.stringify({
                ...spec,
                valueAxis: { ...spec.valueAxis, format },
                data: data(ref([0, 1], [0, 0]), series(ref([0, 1], [1, 1]), 'Share')),
            }),
        };
    };

    test('draws the box with the cells’ labels, and ticks in the first value cell’s format', () => {
        const svg = renderSheetChartSvg(chart(null), shares);
        expect(svg).toStartWith('<svg');
        expect(svg).toContain('width="400" height="300"');
        expect(svg).toContain('>Ajax<');
        expect(svg).toContain('>PSV<');
        expect(svg).toContain('>50%<');
    });

    test('a stored axis format wins over the cells’', () => {
        expect(renderSheetChartSvg(chart('0.00'), shares)).toContain('>0.50<');
    });
});
