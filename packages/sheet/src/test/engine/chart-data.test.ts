import { describe, expect, test } from 'bun:test';
import {
    CHART_MAX_SIDE,
    chartColor,
    FLAT_CHART_LOOK,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    parseChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, RangeChartData, RangeChartSeries } from '@workspace/lib/types/chart';
import { serializeFill } from '@workspace/lib/vector';
import { createArrayResolver } from '../../engine/cell-resolver';
import { inlineChartSpec, renderSheetChartSvg, resolveRangeChartData } from '../../engine/chart-data';
import type { Cell } from '../../engine/types';

const STYLE = { color: '#2a78d6', markers: false, smooth: false };

const ref = (row: [number, number], column: [number, number], sheetId = 's1'): CellRangeRef => ({
    sheetId,
    row,
    column,
});

const series = (values: CellRangeRef | null, name: string | CellRangeRef = 'Points'): RangeChartSeries => ({
    ...STYLE,
    id: 's-0',
    name,
    values,
});

// Each series' id is its place.
const data = (categories: CellRangeRef | null, ...list: RangeChartSeries[]): RangeChartData => ({
    source: 'range',
    categories,
    series: list.map((s, i) => ({ ...s, id: `s-${i}` })),
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
                { ...STYLE, id: 's-0', name: 'Points', values: [42, null, null] },
                { ...STYLE, id: 's-1', name: 'Points', values: [3, 1000, 7] },
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
                { ...STYLE, id: 's-0', name: 'Points', values: [null, 7] },
                { ...STYLE, id: 's-1', name: 'Points', values: [42] },
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
            series: [{ ...STYLE, id: 's-1', color: '#ff0000', name: 'Goals', values: [3, 1000, 7] }],
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

    test('draws the look the chart stores, a hatch inside a clip of its outline, and flat without one', () => {
        const fill = serializeFill({ type: 'solid', color: 'transparent', style: 'cross-hatch' });
        const svg = renderSheetChartSvg({ ...chart(null), fill, color: '#334455', roughness: 1 }, shares);
        expect(svg).toContain('<clipPath id="');
        expect(svg).toContain('<g clip-path="url(#');
        expect(svg).toContain('fill="#334455"');
        const flat = renderSheetChartSvg(chart(null), shares);
        expect(flat).not.toContain('<clipPath');
        expect(flat).toContain(`fill="${FLAT_CHART_LOOK.color}"`);
    });

    // A peer or a file can store any number; at a trillion px the painter overflows its stack.
    test('a stored side past the max draws at the max', () => {
        const svg = renderSheetChartSvg({ ...chart(null), width: 9.4e11, height: 9.4e11 }, shares);
        expect(svg).toContain(`width="${CHART_MAX_SIDE}" height="${CHART_MAX_SIDE}"`);
    });
});

describe('inlineChartSpec', () => {
    const sheetChart = (spec: object): SheetChart => ({
        id: 'c1',
        index: 'a0',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        spec: JSON.stringify(spec),
    });
    const auto = (values: CellRangeRef | null, name: string | CellRangeRef = 'Points'): RangeChartSeries => ({
        ...series(values, name),
        color: null,
    });
    const rangeChart = (...list: RangeChartSeries[]) =>
        sheetChart({ ...sampleChartSpec('line'), title: 'Scores', data: data(ref([1, 3], [0, 0]), ...list) });

    test('a range chart copies as the same chart with its cells read into inline data', () => {
        const spec = parseChartSpec(
            inlineChartSpec(rangeChart(auto(ref([1, 3], [2, 2]), ref([0, 0], [1, 1]))), resolver) ?? '',
        );
        expect(spec).toEqual({
            ...sampleChartSpec('line'),
            title: 'Scores',
            data: {
                source: 'inline',
                categories: ['Ajax', 'PSV', ''],
                series: [
                    { color: null, markers: false, smooth: false, id: 's-0', name: 'Points', values: [3, 1000, 7] },
                ],
            },
        });
    });

    test('an automatic color stays automatic, and one a deleted series before it would shift keeps its color', () => {
        const copied = inlineChartSpec(
            rangeChart(auto(ref([1, 3], [1, 1])), auto(null), auto(ref([1, 3], [2, 2]))),
            resolver,
        );
        const colors = parseChartSpec(copied ?? '')?.data.series.map((s) => s.color);
        expect(colors).toEqual([null, chartColor(2)]);
    });

    test('ticks drawn from the source cells keep their format, and a stored format stays', () => {
        const percent: Cell = { v: 0.25, m: '25%', ct: { fa: '0%', t: 'n' } };
        const shares = createArrayResolver([
            {
                id: 's1',
                name: 'Sheet1',
                data: [[{ v: 'Ajax', m: 'Ajax' }, percent]],
                calculationChain: [],
                dynamicArrayCompute: [],
            },
        ]);
        const spec = sampleChartSpec('column');
        const withFormat = (format: string | null) =>
            sheetChart({
                ...spec,
                valueAxis: { ...spec.valueAxis, format },
                data: data(ref([0, 0], [0, 0]), series(ref([0, 0], [1, 1]))),
            });
        expect(parseChartSpec(inlineChartSpec(withFormat(null), shares) ?? '')?.valueAxis.format).toBe('0%');
        expect(parseChartSpec(inlineChartSpec(withFormat('0.00'), shares) ?? '')?.valueAxis.format).toBe('0.00');
    });

    test('an inline chart copies its stored spec as it is', () => {
        const chart = { ...sheetChart(sampleChartSpec('pie')), spec: `${JSON.stringify(sampleChartSpec('pie'))} ` };
        expect(inlineChartSpec(chart, resolver)).toBe(chart.spec);
    });

    test('a chart showing #REF!, too much data or nothing copies nothing', () => {
        expect(inlineChartSpec(rangeChart(auto(ref([1, 3], [1, 2]))), resolver)).toBeNull();
        expect(inlineChartSpec(rangeChart(auto(ref([0, MAX_CHART_POINTS], [1, 1]))), resolver)).toBeNull();
        expect(inlineChartSpec({ ...rangeChart(), spec: '{' }, resolver)).toBeNull();
    });

    test('a chart whose cells pass the spec’s size limit copies nothing', () => {
        const rows = 1000;
        const long = createArrayResolver([
            {
                id: 's1',
                name: 'Sheet1',
                data: Array.from({ length: rows }, (_, r) => [
                    { v: 'x'.repeat(100) + r, m: 'x'.repeat(100) + r },
                    { v: r },
                ]),
                calculationChain: [],
                dynamicArrayCompute: [],
            },
        ]);
        const chart = sheetChart({
            ...sampleChartSpec('column'),
            data: data(ref([0, rows - 1], [0, 0]), series(ref([0, rows - 1], [1, 1]))),
        });
        expect(inlineChartSpec(chart, long)).toBeNull();
    });
});
