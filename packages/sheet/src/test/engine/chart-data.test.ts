import { describe, expect, test } from 'bun:test';
import { MAX_CHART_LABEL_LENGTH, MAX_CHART_POINTS } from '@workspace/lib/charts';
import type { CellRangeRef, RangeChartData, RangeChartSeries } from '@workspace/lib/types/chart';
import { createArrayResolver } from '../../engine/cell-resolver';
import { resolveRangeChartData } from '../../engine/chart-data';
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

    test('a ref spanning rows and columns, a null ref or a ref to a missing sheet is a ref error', () => {
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
