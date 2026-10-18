import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    chartSearchText,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    MAX_CHART_SPEC_BYTES,
    parseChartSpec,
    sampleChartSpec,
} from '../../charts';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../../sheets';
import {
    CHART_STACKINGS,
    CHART_TYPES,
    type ChartSpec,
    type InlineChartData,
    type RangeChartData,
} from '../../types/chart';
import { isColorToken } from '../../vector/fill';

const style = { color: '#2a78d6', markers: false, smooth: false };

function inlineData(seriesCount: number, pointCount: number): InlineChartData {
    return {
        source: 'inline',
        categories: Array.from({ length: pointCount }, (_, i) => `C${i}`),
        series: Array.from({ length: seriesCount }, (_, i) => ({
            ...style,
            name: `S${i}`,
            values: Array.from({ length: pointCount }, (_, j) => j),
        })),
    };
}

function chart(patch: Partial<ChartSpec> = {}): ChartSpec {
    return { ...sampleChartSpec('column'), ...patch };
}

// A raw stored object, so a test can write what the type forbids.
function stored(patch: Record<string, unknown>): string {
    return JSON.stringify({ ...sampleChartSpec('column'), ...patch });
}

const rangeData: RangeChartData = {
    source: 'range',
    categories: { sheetId: 'sheet-1', row: [1, 4], column: [0, 0] },
    series: [
        {
            ...style,
            name: { sheetId: 'sheet-1', row: [0, 0], column: [1, 1] },
            values: { sheetId: 'sheet-1', row: [1, 4], column: [1, 1] },
        },
        { ...style, color: '#eb6834', markers: true, smooth: true, name: 'Literal', values: null },
    ],
};

describe('sampleChartSpec', () => {
    test('every chart type round-trips through its stored string', () => {
        for (const type of CHART_TYPES) {
            const spec = sampleChartSpec(type);
            expect(spec.type).toBe(type);
            expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
        }
    });

    test("Google's sample: Points scored, two periods over four teams; pie draws one series and names each slice", () => {
        const column = sampleChartSpec('column');
        expect(column.title).toBe('Points scored');
        expect(column.legend).toBe('top');
        expect(column.valueAxis.gridlines).toBe(true);
        expect(column.data).toMatchObject({ source: 'inline', categories: ['Team 1', 'Team 2', 'Team 3', 'Team 4'] });
        expect(column.data.series.map((s) => s.name)).toEqual(['Period 1', 'Period 2']);
        expect(column.stacking).toBe('none');
        const pie = sampleChartSpec('pie');
        expect(pie.legend).toBe('none');
        expect(pie.data.series).toHaveLength(1);
    });

    test("the sample draws in Google's Inter", () => {
        for (const type of CHART_TYPES) expect(sampleChartSpec(type).fontFamily).toBe('Inter');
    });
});

describe('chartSearchText', () => {
    test("a chart's titles, series names and categories, a line each; none for a spec that doesn't parse", () => {
        expect(chartSearchText(sampleChartSpec('line')).split('\n')).toEqual([
            'Points scored',
            'Period 1',
            'Period 2',
            'Team 1',
            'Team 2',
            'Team 3',
            'Team 4',
        ]);
        expect(chartSearchText(null)).toBe('');
    });
});

describe('palette', () => {
    const palette = EIGEN_ACCENT_COLORS_SHUFFLED.map(({ value }) => value);

    test('series take the shared accent colors in the shuffled order calendars assign, so neighbors stay apart', () => {
        expect(palette.map((_, i) => chartColor(i))).toEqual(palette);
    });

    test('a sample stores no colors, so its series and slices take the palette as it is when drawn', () => {
        for (const type of CHART_TYPES) {
            const { data, sliceColors } = sampleChartSpec(type);
            expect(data.series.map((s) => s.color)).toEqual(data.series.map(() => null));
            expect(sliceColors).toEqual([]);
        }
    });

    test('the grid’s series never repeat a color, and the one past the palette starts over', () => {
        expect(palette.length).toBeGreaterThanOrEqual(INLINE_GRID_MAX_SERIES);
        expect(new Set(palette).size).toBe(palette.length);
        expect(palette.every(isColorToken)).toBe(true);
        expect(chartColor(palette.length)).toBe(chartColor(0));
    });
});

describe('parseChartSpec', () => {
    test('malformed JSON and non-objects read as null', () => {
        for (const bad of ['', '{', 'null', '42', '"chart"', '[]', '{}']) {
            expect(parseChartSpec(bad)).toBeNull();
        }
    });

    test('an unknown type or data source rejects the spec', () => {
        expect(parseChartSpec(stored({ type: 'area' }))).toBeNull();
        expect(parseChartSpec(stored({ data: { ...inlineData(1, 1), source: 'cache' } }))).toBeNull();
        expect(parseChartSpec(stored({ data: undefined }))).toBeNull();
        expect(parseChartSpec(stored({ data: { ...inlineData(1, 1), series: [42] } }))).toBeNull();
    });

    test('a missing or invalid presentation field reads its default, so a field added later reads on old charts', () => {
        const { blanks, valueAxis, ...rest } = chart();
        expect(parseChartSpec(JSON.stringify(rest))).toEqual(chart());
        expect(parseChartSpec(stored({ legend: 'center' }))?.legend).toBe('top');
        expect(parseChartSpec(stored({ type: 'pie', legend: 'center' }))?.legend).toBe('none');
        expect(parseChartSpec(stored({ blanks: 'skip' }))?.blanks).toBe('gap');
        expect(parseChartSpec(stored({ stacking: 'yes' }))?.stacking).toBe('none');
        expect(parseChartSpec(stored({ title: 7 }))?.title).toBe('');
        expect(parseChartSpec(stored({ valueAxis: { min: 'Infinity', gridlines: 1, format: 3 } }))?.valueAxis).toEqual(
            valueAxis,
        );
        expect(
            parseChartSpec(stored({ categoryAxis: { title: 'T', visible: 0, reversed: 'yes' } }))?.categoryAxis,
        ).toEqual({ title: 'T', visible: true, reversed: false });
        expect(parseChartSpec(stored({ valueAxis: { visible: null } }))?.valueAxis.visible).toBe(true);
    });

    test('a hidden or reversed axis reads back as stored', () => {
        const spec = chart({
            categoryAxis: { title: '', visible: false, reversed: true },
            valueAxis: { ...chart().valueAxis, visible: false },
        });
        expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
    });

    test('the font is one of the Eigen fonts, and reads Inter when missing or anything else', () => {
        const { fontFamily, ...rest } = chart();
        expect(parseChartSpec(JSON.stringify(rest))?.fontFamily).toBe('Inter');
        for (const bad of ['Comic Sans', 'Inter; color: red', 7, null]) {
            expect(parseChartSpec(stored({ fontFamily: bad }))?.fontFamily).toBe('Inter');
        }
        for (const font of EIGEN_FONT_NAMES)
            expect(parseChartSpec(stored({ fontFamily: font }))?.fontFamily).toBe(font);
    });

    test('a non-number value in an inline series rejects the spec, since values are data', () => {
        const values = (v: unknown) =>
            stored({ data: { ...inlineData(1, 1), series: [{ ...style, name: 'S', values: [v] }] } });
        expect(parseChartSpec(values('NaN'))).toBeNull();
        // JSON.parse reads an overflowing literal as Infinity
        expect(parseChartSpec(values('INF').replace('"INF"', '1e999'))).toBeNull();
    });

    test('a null value is a blank and is kept', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a', 'b'],
            series: [{ ...style, name: 'S', values: [1, null] }],
        };
        expect(parseChartSpec(JSON.stringify(chart({ data })))?.data).toEqual(data);
    });

    test('a series longer or shorter than its categories is kept for the layout to handle', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a'],
            series: [{ ...style, name: 'S', values: [1, 2, 3] }],
        };
        expect(parseChartSpec(JSON.stringify(chart({ data })))?.data).toEqual(data);
    });

    test("stacking reads Excel's grouping: none, stacked or percent", () => {
        for (const stacking of CHART_STACKINGS) expect(parseChartSpec(stored({ stacking }))?.stacking).toBe(stacking);
        expect(parseChartSpec(stored({ stacking: 'normal' }))?.stacking).toBe('none');
        const { stacking, ...rest } = chart();
        expect(parseChartSpec(JSON.stringify({ ...rest, stacked: true }))?.stacking).toBe('none');
    });

    test('a missing color, or one that is not a color token, reads null: the palette color at its index', () => {
        const series = (color: unknown) =>
            parseChartSpec(
                stored({
                    data: {
                        ...inlineData(2, 1),
                        series: [
                            { ...style, name: 'A', values: [1] },
                            { ...style, color, name: 'B', values: [1] },
                        ],
                    },
                }),
            )?.data.series[1];
        expect(series(null)?.color).toBeNull();
        expect(series('url(#x)')?.color).toBeNull();
        expect(series('red')?.color).toBeNull();
        expect(series('#eb6834')?.color).toBe('#eb6834');
        expect(series('transparent')?.color).toBe('transparent');
        const { color, markers, smooth, ...rest } = style;
        expect(
            parseChartSpec(stored({ data: { ...inlineData(1, 1), series: [{ ...rest, name: 7, values: [1] }] } }))?.data
                .series[0],
        ).toEqual({ color: null, markers: false, smooth: false, name: '', values: [1] });
        expect(parseChartSpec(stored({ sliceColors: ['#fff', 'blue', null] }))?.sliceColors).toEqual([
            '#fff',
            null,
            null,
        ]);
        expect(parseChartSpec(stored({ sliceColors: 'blue' }))?.sliceColors).toEqual([]);
    });

    test('a label over the length cap is truncated, not rejected', () => {
        const long = 'x'.repeat(MAX_CHART_LABEL_LENGTH + 50);
        const spec = parseChartSpec(
            JSON.stringify(
                chart({
                    title: long,
                    categoryAxis: { ...chart().categoryAxis, title: long },
                    data: { source: 'inline', categories: [long], series: [{ ...style, name: long, values: [1] }] },
                }),
            ),
        );
        const capped = 'x'.repeat(MAX_CHART_LABEL_LENGTH);
        expect(spec?.title).toBe(capped);
        expect(spec?.categoryAxis.title).toBe(capped);
        expect(spec?.data).toEqual({
            source: 'inline',
            categories: [capped],
            series: [{ ...style, name: capped, values: [1] }],
        });
    });

    test('labels drop characters XML cannot hold, since every label reaches SVG', () => {
        expect(parseChartSpec(stored({ title: 'a\u0000b\u0007c' }))?.title).toBe('abc');
    });

    test('min and max read as null unless min < max', () => {
        const axis = (min: number | null, max: number | null) =>
            parseChartSpec(JSON.stringify(chart({ valueAxis: { ...chart().valueAxis, min, max } })))?.valueAxis;
        expect(axis(0, 100)).toMatchObject({ min: 0, max: 100 });
        expect(axis(-5, null)).toMatchObject({ min: -5, max: null });
        expect(axis(100, 0)).toMatchObject({ min: null, max: null });
        expect(axis(50, 50)).toMatchObject({ min: null, max: null });
    });

    test('a number format is kept, and null means General', () => {
        const format = (f: string | null) =>
            parseChartSpec(JSON.stringify(chart({ valueAxis: { ...chart().valueAxis, format: f } })))?.valueAxis.format;
        expect(format('#,##0.00')).toBe('#,##0.00');
        expect(format(null)).toBeNull();
    });

    test('more series than the hard limit rejects the spec', () => {
        expect(parseChartSpec(JSON.stringify(chart({ data: inlineData(MAX_CHART_SERIES, 1) })))).not.toBeNull();
        expect(parseChartSpec(JSON.stringify(chart({ data: inlineData(MAX_CHART_SERIES + 1, 1) })))).toBeNull();
    });

    test('more points than the hard limit, summed over the series, rejects the spec', () => {
        expect(parseChartSpec(JSON.stringify(chart({ data: inlineData(2, MAX_CHART_POINTS / 2) })))).not.toBeNull();
        expect(parseChartSpec(JSON.stringify(chart({ data: inlineData(2, MAX_CHART_POINTS / 2 + 1) })))).toBeNull();
        const categories = Array.from({ length: MAX_CHART_POINTS + 1 }, () => '');
        expect(
            parseChartSpec(JSON.stringify(chart({ data: { source: 'inline', categories, series: [] } }))),
        ).toBeNull();
    });

    test('more slice colors than the point limit rejects the spec', () => {
        const slices = (count: number) => Array.from({ length: count }, () => '#fff');
        expect(parseChartSpec(stored({ sliceColors: slices(MAX_CHART_POINTS) }))).not.toBeNull();
        expect(parseChartSpec(stored({ sliceColors: slices(MAX_CHART_POINTS + 1) }))).toBeNull();
    });

    test('a stored string over the size limit rejects the spec', () => {
        const padded = JSON.stringify(chart()).replace(/}$/, `,"pad":"${'x'.repeat(MAX_CHART_SPEC_BYTES)}"}`);
        expect(parseChartSpec(padded)).toBeNull();
    });

    test('unknown keys are dropped at every level', () => {
        const spec = chart();
        const raw = {
            ...spec,
            extra: 1,
            valueAxis: { ...spec.valueAxis, extra: 2 },
            data: { ...spec.data, extra: 3, series: spec.data.series.map((s) => ({ ...s, extra: 4 })) },
        };
        expect(parseChartSpec(JSON.stringify(raw))).toEqual(spec);
    });

    test('range data round-trips', () => {
        const spec = chart({ data: rangeData });
        expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
    });

    test('a range ref with a negative, fractional or unordered bound, or an empty sheet id, rejects the spec', () => {
        const ref = { sheetId: 'sheet-1', row: [0, 3], column: [1, 1] };
        const withValues = (values: unknown) =>
            stored({ data: { source: 'range', categories: null, series: [{ ...style, name: 'S', values }] } });
        expect(parseChartSpec(withValues(ref))).not.toBeNull();
        expect(parseChartSpec(withValues({ ...ref, row: [-1, 3] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, row: [3, 0] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, column: [0.5, 1] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, row: [0] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, sheetId: '' }))).toBeNull();
        expect(parseChartSpec(withValues([1, 2]))).toBeNull();
    });

    test("a range ref past Excel's grid rejects the spec", () => {
        const ref = { sheetId: 'sheet-1', row: [0, REFERENCE_ROW_COUNT - 1], column: [0, REFERENCE_COLUMN_COUNT - 1] };
        const withValues = (values: unknown) =>
            stored({ data: { source: 'range', categories: null, series: [{ ...style, name: 'S', values }] } });
        expect(parseChartSpec(withValues(ref))).not.toBeNull();
        expect(parseChartSpec(withValues({ ...ref, row: [0, REFERENCE_ROW_COUNT] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, column: [0, REFERENCE_COLUMN_COUNT] }))).toBeNull();
    });
});

describe('exceedsInlineGridLimits', () => {
    test('the grid edits up to its series and category limits; a longer series counts as rows', () => {
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES, 1))).toBe(false);
        expect(exceedsInlineGridLimits(inlineData(1, INLINE_GRID_MAX_CATEGORIES))).toBe(false);
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES + 1, 1))).toBe(true);
        expect(exceedsInlineGridLimits(inlineData(1, INLINE_GRID_MAX_CATEGORIES + 1))).toBe(true);
        const ragged: InlineChartData = {
            source: 'inline',
            categories: [],
            series: [{ ...style, name: 'S', values: Array(INLINE_GRID_MAX_CATEGORIES + 1).fill(1) }],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });

    test('a full grid of 12 series by 200 rows is past the points limit, so its cells count too', () => {
        expect(INLINE_GRID_MAX_SERIES * INLINE_GRID_MAX_CATEGORIES).toBeGreaterThan(MAX_CHART_POINTS);
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES, INLINE_GRID_MAX_CATEGORIES))).toBe(true);
        expect(exceedsInlineGridLimits(inlineData(10, MAX_CHART_POINTS / 10))).toBe(false);
        expect(fitsInlineGrid(10, MAX_CHART_POINTS / 10)).toBe(true);
        expect(fitsInlineGrid(11, MAX_CHART_POINTS / 10)).toBe(false);
        // A ragged chart's grid pads every series to the longest, so the grid's cells are what count.
        const ragged: InlineChartData = {
            source: 'inline',
            categories: [],
            series: [
                { ...style, name: 'Long', values: Array(INLINE_GRID_MAX_CATEGORIES).fill(1) },
                ...Array.from({ length: INLINE_GRID_MAX_SERIES - 1 }, () => ({ ...style, name: 'Short', values: [1] })),
            ],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });
});
