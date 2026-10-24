import { describe, expect, test } from 'bun:test';
import {
    applyChartSpecChange,
    chartColor,
    chartPointColor,
    chartPointIndex,
    chartPointMoves,
    chartSearchText,
    chartSeriesStyle,
    chartSpecChange,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    holdsUnknownChartData,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    MAX_CHART_SPEC_BYTES,
    MAX_CHART_SPEC_DEPTH,
    newChartSeriesId,
    parseChartSpec,
    readChartSpec,
    sampleChartSpec,
} from '../../charts';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../../sheets';
import type { ChartSpec, ChartSpecChange, InlineChartData, RangeChartData } from '../../types/chart';
import { CHART_STACKINGS, CHART_TYPES } from '../../types/chart';
import { isColorToken } from '../../vector/fill';

function inlineData(seriesCount: number, pointCount: number): InlineChartData {
    return {
        source: 'inline',
        categories: Array.from({ length: pointCount }, (_, i) => `C${i}`),
        series: Array.from({ length: seriesCount }, (_, i) => ({
            id: `s-${i}`,
            name: `S${i}`,
            values: Array.from({ length: pointCount }, (_, j) => j),
        })),
    };
}

// The sample, its series styled automatic for whatever data the patch gives it.
function chart(patch: Partial<ChartSpec> = {}): ChartSpec {
    const sample = sampleChartSpec('column');
    return { ...sample, series: defaultChartSpec('column', patch.data ?? sample.data).series, ...patch };
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
            id: 's-1',
            name: { sheetId: 'sheet-1', row: [0, 0], column: [1, 1] },
            values: { sheetId: 'sheet-1', row: [1, 4], column: [1, 1] },
        },
        { id: 's-2', name: 'Literal', values: null },
    ],
};

// Every key of the spec is one of its eight parts: a ninth fails to compile here.
const PARTS: Record<keyof ChartSpec, true> = {
    chart: true,
    title: true,
    legend: true,
    axes: true,
    plots: true,
    series: true,
    points: true,
    data: true,
};

describe('the shape', () => {
    test('a spec is eight parts, each a record', () => {
        const spec = sampleChartSpec('column');
        expect(Object.keys(spec).sort()).toEqual(Object.keys(PARTS).sort());
        for (const part of Object.values(spec)) expect(typeof part === 'object' && !Array.isArray(part)).toBe(true);
    });
});

describe('sampleChartSpec', () => {
    test('every chart type round-trips through its stored string', () => {
        for (const type of CHART_TYPES) {
            const spec = sampleChartSpec(type);
            expect(spec.chart.type).toBe(type);
            expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
        }
    });

    test("the sample: where a star's light goes, three sources over seven 100 nm bins; pie draws the Sun", () => {
        const column = sampleChartSpec('column');
        expect(column.title.text).toBe("Where a star's light goes");
        expect(column.axes.x.title.text).toBe('Wavelength (nm)');
        expect(column.axes.y.title.text).toBe('Share of light, 300–1000 nm (%)');
        expect(column.legend.position).toBe('top');
        expect(column.axes.y.gridlines.visible).toBe(true);
        expect(column.axes.x.gridlines.visible).toBe(false);
        expect(column.data).toMatchObject({
            source: 'inline',
            categories: ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'],
        });
        expect(column.data.series.map((s) => s.name)).toEqual(['Sun', 'Bulb (incandescent)', 'Hot star']);
        expect(column.plots.column.stacking).toBe('none');
        const pie = sampleChartSpec('pie');
        expect(pie.legend.position).toBe('none');
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

    test("the sample draws in Google's Inter, or the host's font", () => {
        for (const type of CHART_TYPES) expect(sampleChartSpec(type).chart.fontFamily).toBe('Inter');
        expect(sampleChartSpec('bar', 'Excalifont').chart.fontFamily).toBe('Excalifont');
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
            const spec = sampleChartSpec(type);
            expect(spec.data.series.map((s) => spec.series[s.id].color)).toEqual(spec.data.series.map(() => null));
            expect(spec.points).toEqual({});
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

    test('an unknown type or data source, or no chart part, rejects the spec', () => {
        expect(parseChartSpec(stored({ chart: { type: 'area' } }))).toBeNull();
        expect(parseChartSpec(stored({ chart: undefined }))).toBeNull();
        expect(parseChartSpec(stored({ chart: 'column' }))).toBeNull();
        expect(parseChartSpec(stored({ data: { ...inlineData(1, 1), source: 'cache' } }))).toBeNull();
        expect(parseChartSpec(stored({ data: undefined }))).toBeNull();
        expect(parseChartSpec(stored({ data: { ...inlineData(1, 1), series: [42] } }))).toBeNull();
    });

    test('a missing or invalid presentation field reads its default, so a field added later reads on old charts', () => {
        const { legend, axes, plots, ...rest } = chart();
        const defaults = defaultChartSpec('column', chart().data);
        expect(parseChartSpec(JSON.stringify({ ...rest, chart: { type: 'column' } }))).toEqual(
            chart({ legend: defaults.legend, axes: defaults.axes }),
        );
        expect(parseChartSpec(stored({ legend: { position: 'center' } }))?.legend.position).toBe('top');
        expect(parseChartSpec(stored({ chart: { type: 'pie' }, legend: 'right' }))?.legend.position).toBe('none');
        expect(parseChartSpec(stored({ chart: { type: 'column', blanks: 'skip' } }))?.chart.blanks).toBe('gap');
        expect(parseChartSpec(stored({ plots: { column: { stacking: 'yes' } } }))?.plots.column.stacking).toBe('none');
        expect(parseChartSpec(stored({ title: { text: 7 } }))?.title.text).toBe('');
        expect(parseChartSpec(stored({ title: 'Old' }))?.title.text).toBe('');
        expect(
            parseChartSpec(
                stored({
                    axes: { y: { scale: { min: 'Infinity' }, gridlines: { visible: 1 }, labels: { format: 3 } } },
                }),
            )?.axes.y,
        ).toEqual(defaults.axes.y);
        expect(
            parseChartSpec(stored({ axes: { x: { title: { text: 'T' }, visible: 0, scale: { reversed: 'yes' } } } }))
                ?.axes.x,
        ).toEqual({ ...defaults.axes.x, title: { text: 'T' } });
        expect(parseChartSpec(stored({ axes: { y: { visible: null } } }))?.axes.y.visible).toBe(true);
        expect(parseChartSpec(stored({ axes: 'x' }))?.axes).toEqual(defaults.axes);
    });

    test("an unknown axis kind reads its id's, and an axis this build doesn't draw is left out", () => {
        const axes = parseChartSpec(
            stored({ axes: { x: { kind: 'date' }, y: { kind: 'log' }, y2: { kind: 'value', visible: false } } }),
        )?.axes;
        expect([axes?.x.kind, axes?.y.kind]).toEqual(['category', 'value']);
        expect(Object.keys(axes ?? {})).toEqual(['x', 'y']);
        expect(parseChartSpec(stored({ axes: { x: { kind: 'value' } } }))?.axes.x.kind).toBe('value');
    });

    test("a series' unknown plot type draws in the chart's, and a series on an axis this build doesn't draw draws on y", () => {
        const style = (series: unknown) => parseChartSpec(stored({ series: { 's-1': series } }))?.series['s-1'];
        expect(style({ plot: 'line' })?.plot).toBe('line');
        expect(style({ plot: 'area' })?.plot).toBeNull();
        expect(style({ yAxis: 'y2' })?.yAxis).toBe('y');
        expect(style({ yAxis: 'y3' })?.yAxis).toBe('y');
        expect(style({ line: { smooth: true }, marker: { visible: true } })).toEqual({
            ...DEFAULT_CHART_SERIES_STYLE,
            line: { smooth: true },
            marker: { visible: true },
        });
        expect(style({ line: true, marker: 'circle' })).toEqual(DEFAULT_CHART_SERIES_STYLE);
    });

    test('every series in data has a style, and a style for a series data no longer names is left out', () => {
        const spec = parseChartSpec(stored({ series: { 's-1': { color: '#eb6834' }, 's-9': { color: '#000000' } } }));
        expect(Object.keys(spec?.series ?? {})).toEqual(['s-1', 's-2', 's-3']);
        expect(spec?.series['s-1'].color).toBe('#eb6834');
        expect(spec?.series['s-2']).toEqual(DEFAULT_CHART_SERIES_STYLE);
    });

    test("a point's key is a canonical index under the point limit, and a series data doesn't name has none", () => {
        const points = parseChartSpec(
            stored({
                points: {
                    's-1': {
                        0: { color: '#eb6834' },
                        3: { color: 'blue' },
                        1999: { color: '#000001' },
                        2000: { color: '#000002' },
                        '03': { color: '#000003' },
                        '-1': { color: '#000004' },
                        '1e3': { color: '#000005' },
                        5: '#000006',
                    },
                    's-2': {},
                    's-9': { 0: { color: '#000007' } },
                },
            }),
        )?.points;
        expect(points).toEqual({ 's-1': { 0: { color: '#eb6834' }, 3: { color: null }, 1999: { color: '#000001' } } });
        expect(parseChartSpec(stored({ points: ['#fff'] }))?.points).toEqual({});
        expect(['0', '7', '1999', '2000', '03', '-1', '1e3', '1.0', ''].map(chartPointIndex)).toEqual([
            0,
            7,
            1999,
            null,
            null,
            null,
            null,
            null,
            null,
        ]);
    });

    test('a hidden or reversed axis reads back as stored', () => {
        const { x, y } = chart().axes;
        const spec = chart({
            axes: { x: { ...x, visible: false, scale: { ...x.scale, reversed: true } }, y: { ...y, visible: false } },
        });
        expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
    });

    test('the font is one of the Eigen fonts, and reads Inter when missing or anything else', () => {
        expect(parseChartSpec(stored({ chart: { type: 'column' } }))?.chart.fontFamily).toBe('Inter');
        for (const bad of ['Comic Sans', 'Inter; color: red', 7, null]) {
            expect(parseChartSpec(stored({ chart: { type: 'column', fontFamily: bad } }))?.chart.fontFamily).toBe(
                'Inter',
            );
        }
        for (const font of EIGEN_FONT_NAMES)
            expect(parseChartSpec(stored({ chart: { type: 'column', fontFamily: font } }))?.chart.fontFamily).toBe(
                font,
            );
    });

    test('a non-number value in an inline series rejects the spec, since values are data', () => {
        const values = (v: unknown) =>
            stored({ data: { ...inlineData(1, 1), series: [{ id: 's-1', name: 'S', values: [v] }] } });
        expect(parseChartSpec(values('NaN'))).toBeNull();
        // JSON.parse reads an overflowing literal as Infinity
        expect(parseChartSpec(values('INF').replace('"INF"', '1e999'))).toBeNull();
    });

    test('a null value is a blank and is kept', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a', 'b'],
            series: [{ id: 's-1', name: 'S', values: [1, null] }],
        };
        expect(parseChartSpec(JSON.stringify(chart({ data })))?.data).toEqual(data);
    });

    test('a series longer or shorter than its categories is kept for the layout to handle', () => {
        const data: InlineChartData = {
            source: 'inline',
            categories: ['a'],
            series: [{ id: 's-1', name: 'S', values: [1, 2, 3] }],
        };
        expect(parseChartSpec(JSON.stringify(chart({ data })))?.data).toEqual(data);
    });

    test("stacking reads Excel's grouping per plot type: none, stacked or percent", () => {
        for (const stacking of CHART_STACKINGS)
            expect(parseChartSpec(stored({ plots: { column: { stacking } } }))?.plots.column.stacking).toBe(stacking);
        const plots = parseChartSpec(
            stored({ plots: { bar: { stacking: 'percent' }, column: { stacking: 'normal' } } }),
        )?.plots;
        expect(plots).toEqual({
            column: { stacking: 'none' },
            bar: { stacking: 'percent' },
            line: { stacking: 'none' },
            pie: { stacking: 'none' },
        });
    });

    test('a missing color, or one that is not a color token, reads null: the palette color at its index', () => {
        const color = (value: unknown) =>
            parseChartSpec(stored({ series: { 's-2': { color: value } } }))?.series['s-2'];
        expect(color(null)?.color).toBeNull();
        expect(color('url(#x)')?.color).toBeNull();
        expect(color('red')?.color).toBeNull();
        expect(color('#eb6834')?.color).toBe('#eb6834');
        expect(color('transparent')?.color).toBe('transparent');
        expect(
            parseChartSpec(stored({ data: { ...inlineData(1, 1), series: [{ id: 's-1', name: 7, values: [1] }] } }))
                ?.data.series[0],
        ).toEqual({ id: 's-1', name: '', values: [1] });
        const point = (value: unknown) =>
            parseChartSpec(stored({ points: { 's-1': { 0: { color: value } } } }))?.points['s-1'][0].color;
        expect([point('#fff'), point('blue'), point(null)]).toEqual(['#fff', null, null]);
    });

    test('a label over the length cap is truncated, not rejected', () => {
        const long = 'x'.repeat(MAX_CHART_LABEL_LENGTH + 50);
        const spec = parseChartSpec(
            JSON.stringify(
                chart({
                    title: { text: long },
                    axes: { ...chart().axes, x: { ...chart().axes.x, title: { text: long } } },
                    data: {
                        source: 'inline',
                        categories: [long],
                        series: [{ id: 's-1', name: long, values: [1] }],
                    },
                }),
            ),
        );
        const capped = 'x'.repeat(MAX_CHART_LABEL_LENGTH);
        expect(spec?.title.text).toBe(capped);
        expect(spec?.axes.x.title.text).toBe(capped);
        expect(spec?.data).toEqual({
            source: 'inline',
            categories: [capped],
            series: [{ id: 's-1', name: capped, values: [1] }],
        });
    });

    test('labels drop characters XML cannot hold, since every label reaches SVG', () => {
        expect(parseChartSpec(stored({ title: { text: 'a\u0000b\u0007c' } }))?.title.text).toBe('abc');
    });

    test('min and max read as null unless min < max', () => {
        const axis = (min: number | null, max: number | null) =>
            parseChartSpec(stored({ axes: { y: { scale: { min, max } } } }))?.axes.y.scale;
        expect(axis(0, 100)).toMatchObject({ min: 0, max: 100 });
        expect(axis(-5, null)).toMatchObject({ min: -5, max: null });
        expect(axis(100, 0)).toMatchObject({ min: null, max: null });
        expect(axis(50, 50)).toMatchObject({ min: null, max: null });
    });

    test('a number format is kept, and null means General', () => {
        const format = (f: string | null) =>
            parseChartSpec(stored({ axes: { y: { labels: { format: f } } } }))?.axes.y.labels.format;
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

    test('a stored string over the size limit rejects the spec', () => {
        const padded = JSON.stringify(chart()).replace(/}$/, `,"pad":"${'x'.repeat(MAX_CHART_SPEC_BYTES)}"}`);
        expect(parseChartSpec(padded)).toBeNull();
    });

    test('the resolved view drops unknown keys at every level', () => {
        const spec = chart();
        const raw = {
            ...spec,
            extra: 1,
            chart: { ...spec.chart, extra: 2 },
            axes: { ...spec.axes, y: { ...spec.axes.y, extra: 2, scale: { ...spec.axes.y.scale, extra: 2 } } },
            series: { ...spec.series, 's-1': { ...spec.series['s-1'], extra: 2, line: { smooth: false, extra: 2 } } },
            points: { 's-1': { 0: { color: '#eb6834', extra: 2 } } },
            data: { ...spec.data, extra: 3, series: spec.data.series.map((s) => ({ ...s, extra: 4 })) },
        };
        expect(parseChartSpec(JSON.stringify(raw))).toEqual({
            ...spec,
            points: { 's-1': { 0: { color: '#eb6834' } } },
        });
    });

    test('range data round-trips', () => {
        const spec = chart({ data: rangeData });
        expect(parseChartSpec(JSON.stringify(spec))).toEqual(spec);
    });

    test('a range ref with a negative, fractional or unordered bound, or an empty sheet id, rejects the spec', () => {
        const ref = { sheetId: 'sheet-1', row: [0, 3], column: [1, 1] };
        const withValues = (values: unknown) =>
            stored({
                data: { source: 'range', categories: null, series: [{ id: 's-1', name: 'S', values }] },
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
                data: { source: 'range', categories: null, series: [{ id: 's-1', name: 'S', values }] },
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
                series: ids.map((id, i) => ({ id, name: `S${i}`, values: [1] })),
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

describe('readChartSpec', () => {
    test('returns the spec as stored, unknown keys and values in place, beside the view resolved from it', () => {
        const raw = { ...chart(), legend: { position: 'inside' }, future: { on: true } };
        const { stored, spec } = readChartSpec(JSON.stringify(raw));
        expect(stored).toEqual(raw);
        expect(spec).toEqual(chart());
    });

    test('a spec that does not resolve keeps what is stored; one that is no JSON object, or past the limit, has none', () => {
        const scatter = stored({ chart: { type: 'scatter' } });
        expect(readChartSpec(scatter)).toEqual({ stored: JSON.parse(scatter), spec: null });
        for (const value of ['{', '[1]', '"x"']) expect(readChartSpec(value)).toEqual({ stored: {}, spec: null });
        const padded = JSON.stringify({ ...chart(), pad: 'x'.repeat(MAX_CHART_SPEC_BYTES) });
        expect(readChartSpec(padded)).toEqual({ stored: {}, spec: null });
    });

    // The spec is one level, so a key on it nested `levels` deep reaches 1 + levels.
    const nested = (levels: number, open: string, close: string, base = stored({})) =>
        base.replace(/}$/, `,"future":${open.repeat(levels)}0${close.repeat(levels)}}`);

    test('a spec nested up to the depth limit reads; one level past it has none, in arrays and in records', () => {
        for (const [open, close] of [
            ['[', ']'],
            ['{"a":', '}'],
        ]) {
            const deepest = nested(MAX_CHART_SPEC_DEPTH - 1, open, close);
            expect(readChartSpec(deepest)).toEqual({ stored: JSON.parse(deepest), spec: chart() });
            expect(readChartSpec(nested(MAX_CHART_SPEC_DEPTH, open, close))).toEqual({ stored: {}, spec: null });
        }
    });

    test('brackets inside a string are no nesting, after an escaped quote too, and an escaped backslash ends it', () => {
        const brackets = '[{'.repeat(MAX_CHART_SPEC_DEPTH);
        for (const pad of [brackets, `"${brackets}`, `\\"${brackets}`]) {
            const value = stored({ pad });
            expect(readChartSpec(value)).toEqual({ stored: JSON.parse(value), spec: chart() });
        }
        const afterBackslash = nested(MAX_CHART_SPEC_DEPTH, '[', ']', stored({ pad: '\\' }));
        expect(readChartSpec(afterBackslash)).toEqual({ stored: {}, spec: null });
    });
});

describe('chartSpecChange', () => {
    test('is the leaves that differ; records are walked and arrays set whole', () => {
        const base = chart();
        const next = {
            ...base,
            title: { text: 'New' },
            axes: { ...base.axes, y: { ...base.axes.y, scale: { ...base.axes.y.scale, max: 50 } } },
            points: { 's-1': { 0: { color: '#eb6834' } } },
        };
        expect(chartSpecChange(base, next)).toEqual([
            { op: 'set', path: ['title', 'text'], value: 'New' },
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
            { op: 'set', path: ['points', 's-1'], value: { 0: { color: '#eb6834' } } },
        ]);
    });

    test('a spread that reorders the keys changes nothing', () => {
        const base = chart();
        const { title, data, ...rest } = base;
        expect(chartSpecChange(base, { data, ...rest, title })).toEqual([]);
    });
});

describe('applyChartSpecChange', () => {
    const raw = {
        ...chart(),
        future: 1,
        legend: { position: 'inside' },
        axes: { ...chart().axes, y: { ...chart().axes.y, scale: { ...chart().axes.y.scale, logBase: 10 } } },
        data: {
            ...chart().data,
            future: 3,
            series: chart().data.series.map((series) => ({ ...series, sizes: [1, 2] })),
        },
    };
    const apply = (change: ChartSpecChange) => applyChartSpecChange(readChartSpec(JSON.stringify(raw)).stored, change);

    test('unknown keys at every level, and an unknown legend, survive a change elsewhere', () => {
        const next = apply([
            { op: 'set', path: ['title', 'text'], value: 'New' },
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
        ]);
        expect(JSON.parse(JSON.stringify(next))).toEqual({
            ...raw,
            title: { text: 'New' },
            axes: { ...raw.axes, y: { ...raw.axes.y, scale: { ...raw.axes.y.scale, max: 50 } } },
        });
    });

    test('leaves the stored spec it was given as it was', () => {
        const { stored: before } = readChartSpec(JSON.stringify(raw));
        applyChartSpecChange(before, [{ op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 }]);
        expect(before).toEqual(raw);
    });

    test('a series list is set whole, each series laid over the stored one with its id, a gone one gone', () => {
        const [, second, third] = chart().data.series;
        const next = apply([{ op: 'set', path: ['data', 'series'], value: [{ ...third, name: 'Hot' }, second] }]);
        expect(JSON.parse(JSON.stringify(next)).data.series).toEqual([
            { ...third, name: 'Hot', sizes: [1, 2] },
            { ...second, sizes: [1, 2] },
        ]);
        const fresh = { ...third, id: 's-new' };
        expect(
            JSON.parse(JSON.stringify(apply([{ op: 'set', path: ['data', 'series'], value: [fresh] }]))).data.series,
        ).toEqual([fresh]);
    });

    test('a set makes the records along its path; a remove of what is not there changes nothing', () => {
        const next = apply([{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]);
        expect(next.points).toEqual({ 's-1': { 3: { color: '#eb6834' } } });
        expect(apply([{ op: 'remove', path: ['future'] }]).future).toBeUndefined();
        expect(apply([{ op: 'remove', path: ['nothing', 'here'] }])).toEqual(readChartSpec(JSON.stringify(raw)).stored);
    });

    test('a move takes the value to its new path, and nothing at from leaves nothing there', () => {
        const next = apply([{ op: 'move', from: ['future'], path: ['past'] }]);
        expect([next.future, next.past]).toEqual([undefined, 1]);
        expect(apply([{ op: 'move', from: ['nothing'], path: ['future'] }]).future).toBeUndefined();
    });

    test('the records it makes and copies have no prototype', () => {
        const next = apply([{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]);
        expect(Object.getPrototypeOf(next)).toBeNull();
        expect(Object.getPrototypeOf(next.points)).toBeNull();
    });

    test('an op through __proto__, constructor or prototype changes nothing and leaves Object.prototype alone', () => {
        const before = readChartSpec(JSON.stringify(raw)).stored;
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            const change: ChartSpecChange = [
                { op: 'set', path: [key, 'polluted'], value: true },
                { op: 'set', path: ['axes', key], value: { polluted: true } },
                { op: 'remove', path: [key] },
                { op: 'move', from: ['future'], path: [key] },
            ];
            expect(applyChartSpecChange(before, change)).toBe(before);
        }
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });

    test('a stored __proto__ key stays data through a change', () => {
        const { stored: read } = readChartSpec(stored({ ['__proto__']: { polluted: true } }));
        const next = applyChartSpecChange(read, [{ op: 'set', path: ['title', 'text'], value: 'New' }]);
        expect(JSON.stringify(next)).toContain('"__proto__":{"polluted":true}');
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });
});

describe('holdsUnknownChartData', () => {
    const read = (raw: object) => {
        const { stored: storedSpec, spec } = readChartSpec(JSON.stringify(raw));
        if (!spec) throw new Error('the spec does not parse');
        return holdsUnknownChartData(storedSpec, spec);
    };

    test('says whether the data or a series holds a key this build does not read', () => {
        const spec = chart();
        expect(read(spec)).toBe(false);
        expect(read({ ...spec, future: 1, axes: { ...spec.axes, y: { ...spec.axes.y, logBase: 10 } } })).toBe(false);
        expect(read({ ...spec, data: { ...spec.data, future: 1 } })).toBe(true);
        const sizes = spec.data.series.map((series, i) => (i === 1 ? { ...series, sizes: [1] } : series));
        expect(read({ ...spec, data: { ...spec.data, series: sizes } })).toBe(true);
        const inherited = spec.data.series.map((series) => ({ ...series, toString: 'x' }));
        expect(read({ ...spec, data: { ...spec.data, series: inherited } })).toBe(true);
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
            series: [{ id: 's-1', name: 'S', values: Array(INLINE_GRID_MAX_CATEGORIES + 1).fill(1) }],
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
                { id: 's-0', name: 'Long', values: Array(INLINE_GRID_MAX_CATEGORIES).fill(1) },
                ...Array.from({ length: INLINE_GRID_MAX_SERIES - 1 }, (_, i) => ({
                    id: `s-${i + 1}`,
                    name: 'Short',
                    values: [1],
                })),
            ],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });
});

describe('chartSeriesStyle and chartPointColor', () => {
    test("read a spec's own entries only, so an id an object inherits finds nothing", () => {
        const spec = chart({
            series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#eb6834' } },
            points: { 's-1': { 2: { color: '#2a78d6' } } },
        });
        expect(chartSeriesStyle(spec, 's-1').color).toBe('#eb6834');
        expect(chartSeriesStyle(spec, 'toString')).toEqual(DEFAULT_CHART_SERIES_STYLE);
        expect(chartPointColor(spec, 's-1', 2)).toBe('#2a78d6');
        expect([chartPointColor(spec, 's-1', 0), chartPointColor(spec, 'toString', 0)]).toEqual([null, null]);
    });
});

describe('chartPointMoves', () => {
    const points = (colors: Record<number, string>) => ({
        points: { 's-1': Object.fromEntries(Object.entries(colors).map(([i, color]) => [i, { color, future: i }])) },
    });
    const moved = (before: Record<number, string>, target: (index: number) => number | null) =>
        JSON.parse(JSON.stringify(applyChartSpecChange(points(before), chartPointMoves(points(before), target))))
            .points['s-1'];

    test('a delete removes its points and moves the ones after it down, unknown keys with them', () => {
        const after = moved({ 0: '#000000', 1: '#000001', 2: '#000002', 3: '#000003' }, (i) =>
            i === 1 ? null : i > 1 ? i - 1 : i,
        );
        expect(after).toEqual({
            0: { color: '#000000', future: '0' },
            1: { color: '#000002', future: '2' },
            2: { color: '#000003', future: '3' },
        });
    });

    test('an insert moves the points after it up, from the highest, leaving the inserted ones automatic', () => {
        const after = moved({ 0: '#000000', 1: '#000001', 2: '#000002' }, (i) => (i >= 1 ? i + 1 : i));
        expect(after).toEqual({
            0: { color: '#000000', future: '0' },
            2: { color: '#000001', future: '1' },
            3: { color: '#000002', future: '2' },
        });
    });

    test('only a stored point moves, and an index that stays writes nothing', () => {
        expect(moved({ 1: '#000001' }, (i) => (i === 0 ? 1 : null))).toEqual({});
        expect(chartPointMoves(points({ 0: '#000000', 1: '#000001', 2: '#000002' }), (i) => i)).toEqual([]);
    });
});
