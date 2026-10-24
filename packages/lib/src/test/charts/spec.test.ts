import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    chartSearchText,
    defaultChartPresentation,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    MAX_CHART_SPEC_BYTES,
    newChartSeriesId,
    parseChartSpec,
    sampleChartSpec,
} from '../../charts';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../../sheets';
import type { ChartSpec, InlineChartData, RangeChartData } from '../../types/chart';
import { CHART_STACKINGS, CHART_TYPES } from '../../types/chart';
import { isColorToken } from '../../vector/fill';

const style = { color: '#2a78d6', markers: false, smooth: false };

function inlineData(seriesCount: number, pointCount: number): InlineChartData {
    return {
        source: 'inline',
        categories: Array.from({ length: pointCount }, (_, i) => `C${i}`),
        series: Array.from({ length: seriesCount }, (_, i) => ({
            ...style,
            id: `s-${i}`,
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
            id: 's-1',
            name: { sheetId: 'sheet-1', row: [0, 0], column: [1, 1] },
            values: { sheetId: 'sheet-1', row: [1, 4], column: [1, 1] },
        },
        { ...style, id: 's-2', color: '#eb6834', markers: true, smooth: true, name: 'Literal', values: null },
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

    test("the sample: where a star's light goes, three sources over seven 100 nm bins; pie draws the Sun", () => {
        const column = sampleChartSpec('column');
        expect(column.title).toBe("Where a star's light goes");
        expect(column.categoryAxis.title).toBe('Wavelength (nm)');
        expect(column.valueAxis.title).toBe('Share of light, 300–1000 nm (%)');
        expect(column.legend).toBe('top');
        expect(column.valueAxis.gridlines).toBe(true);
        expect(column.data).toMatchObject({
            source: 'inline',
            categories: ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'],
        });
        expect(column.data.series.map((s) => s.name)).toEqual(['Sun', 'Bulb (incandescent)', 'Hot star']);
        expect(column.stacking).toBe('none');
        const pie = sampleChartSpec('pie');
        expect(pie.legend).toBe('none');
        expect(pie.data.series.map((s) => s.name)).toEqual(['Sun']);
    });

    test("each source's shares are positive and sum to 100, so every type and the pie draw them", () => {
        const { data } = sampleChartSpec('column');
        if (data.source !== 'inline') throw new Error(data.source);
        for (const { values } of data.series) {
            expect(values.every((value) => value !== null && value > 0)).toBe(true);
            expect(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBeCloseTo(100, 9);
        }
    });

    test("the sample draws in Google's Inter", () => {
        for (const type of CHART_TYPES) expect(sampleChartSpec(type).fontFamily).toBe('Inter');
    });
});

describe('chartSearchText', () => {
    test("a chart's titles, series names and categories, a line each; none for a spec that doesn't parse", () => {
        expect(chartSearchText(sampleChartSpec('line')).split('\n')).toEqual([
            "Where a star's light goes",
            'Wavelength (nm)',
            'Share of light, 300–1000 nm (%)',
            'Sun',
            'Bulb (incandescent)',
            'Hot star',
            '300–400',
            '400–500',
            '500–600',
            '600–700',
            '700–800',
            '800–900',
            '900–1000',
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
        const defaults = defaultChartPresentation('column');
        expect(parseChartSpec(JSON.stringify(rest))).toEqual(chart({ valueAxis: defaults.valueAxis }));
        expect(parseChartSpec(stored({ legend: 'center' }))?.legend).toBe('top');
        expect(parseChartSpec(stored({ type: 'pie', legend: 'center' }))?.legend).toBe('none');
        expect(parseChartSpec(stored({ blanks: 'skip' }))?.blanks).toBe('gap');
        expect(parseChartSpec(stored({ stacking: 'yes' }))?.stacking).toBe('none');
        expect(parseChartSpec(stored({ title: 7 }))?.title).toBe('');
        expect(parseChartSpec(stored({ valueAxis: { min: 'Infinity', gridlines: 1, format: 3 } }))?.valueAxis).toEqual(
            defaults.valueAxis,
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
            stored({ data: { ...inlineData(1, 1), series: [{ ...style, id: 's-1', name: 'S', values: [v] }] } });
        expect(parseChartSpec(values('NaN'))).toBeNull();
        // JSON.parse reads an overflowing literal as Infinity
        expect(parseChartSpec(values('INF').replace('"INF"', '1e999'))).toBeNull();
    });

    test('a null value is a blank and is kept', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a', 'b'],
            series: [{ ...style, id: 's-1', name: 'S', values: [1, null] }],
        };
        expect(parseChartSpec(JSON.stringify(chart({ data })))?.data).toEqual(data);
    });

    test('a series longer or shorter than its categories is kept for the layout to handle', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a'],
            series: [{ ...style, id: 's-1', name: 'S', values: [1, 2, 3] }],
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
                            { ...style, id: 's-1', name: 'A', values: [1] },
                            { ...style, id: 's-2', color, name: 'B', values: [1] },
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
            parseChartSpec(
                stored({ data: { ...inlineData(1, 1), series: [{ ...rest, id: 's-1', name: 7, values: [1] }] } }),
            )?.data.series[0],
        ).toEqual({ color: null, markers: false, smooth: false, id: 's-1', name: '', values: [1] });
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
                    data: {
                        source: 'inline',
                        categories: [long],
                        series: [{ ...style, id: 's-1', name: long, values: [1] }],
                    },
                }),
            ),
        );
        const capped = 'x'.repeat(MAX_CHART_LABEL_LENGTH);
        expect(spec?.title).toBe(capped);
        expect(spec?.categoryAxis.title).toBe(capped);
        expect(spec?.data).toEqual({
            source: 'inline',
            categories: [capped],
            series: [{ ...style, id: 's-1', name: capped, values: [1] }],
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
            stored({
                data: { source: 'range', categories: null, series: [{ ...style, id: 's-1', name: 'S', values }] },
            });
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
            stored({
                data: { source: 'range', categories: null, series: [{ ...style, id: 's-1', name: 'S', values }] },
            });
        expect(parseChartSpec(withValues(ref))).not.toBeNull();
        expect(parseChartSpec(withValues({ ...ref, row: [0, REFERENCE_ROW_COUNT] }))).toBeNull();
        expect(parseChartSpec(withValues({ ...ref, column: [0, REFERENCE_COLUMN_COUNT] }))).toBeNull();
    });
});

describe('series ids', () => {
    const withIds = (...ids: unknown[]) =>
        stored({
            data: {
                ...inlineData(ids.length, 1),
                series: ids.map((id, i) => ({ ...style, id, name: `S${i}`, values: [1] })),
            },
        });

    test('every series has a string id of up to 64 letters, digits, - or _, unique in its chart', () => {
        expect(parseChartSpec(withIds('s-1', 'x-0', `A_${'z'.repeat(62)}`))?.data.series.map((s) => s.id)).toEqual([
            's-1',
            'x-0',
            `A_${'z'.repeat(62)}`,
        ]);
        for (const id of [undefined, 7, null, '', 'x'.repeat(65), 's 1', 's/1', 'é']) {
            expect(parseChartSpec(withIds(id))).toBeNull();
        }
        expect(parseChartSpec(withIds('s-1', 's-1'))).toBeNull();
    });

    test("a name a plain object inherits is no id, so a record keyed by ids can't reach a prototype", () => {
        for (const id of ['__proto__', 'constructor', 'prototype']) expect(parseChartSpec(withIds(id))).toBeNull();
    });

    test('a range series needs one too', () => {
        const series = rangeData.series.map(({ id, ...rest }) => rest);
        expect(parseChartSpec(stored({ data: { ...rangeData, series } }))).toBeNull();
    });

    test('a new id is s- and ten of nanoid, and the sample numbers its series', () => {
        expect(newChartSeriesId()).toMatch(/^s-[A-Za-z0-9_-]{10}$/);
        expect(newChartSeriesId()).not.toBe(newChartSeriesId());
        expect(sampleChartSpec('column').data.series.map((s) => s.id)).toEqual(['s-1', 's-2', 's-3']);
        expect(sampleChartSpec('pie').data.series.map((s) => s.id)).toEqual(['s-1']);
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
            series: [{ ...style, id: 's-1', name: 'S', values: Array(INLINE_GRID_MAX_CATEGORIES + 1).fill(1) }],
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
                { ...style, id: 's-0', name: 'Long', values: Array(INLINE_GRID_MAX_CATEGORIES).fill(1) },
                ...Array.from({ length: INLINE_GRID_MAX_SERIES - 1 }, (_, i) => ({
                    ...style,
                    id: `s-${i + 1}`,
                    name: 'Short',
                    values: [1],
                })),
            ],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });
});
