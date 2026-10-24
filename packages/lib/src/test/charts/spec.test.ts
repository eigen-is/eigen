import { describe, expect, spyOn, test } from 'bun:test';
import { upperFirst } from 'es-toolkit';
import {
    applyChartSpecChange,
    chartColor,
    chartPointColor,
    chartPointIndex,
    chartPointMoves,
    chartSearchText,
    chartSeriesStyle,
    chartSpecChange,
    chartSpecWrites,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    holdsUnknownChartData,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    isChartSpecKey,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    MAX_CHART_SPEC_BYTES,
    MAX_CHART_SPEC_DEPTH,
    newChartSeriesId,
    newChartSpecParts,
    newSheetChartSpecParts,
    parseChartSpec,
    readChartSpec,
    sampleChartSpec,
    sheetChartSpecWrites,
} from '../../charts';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../../sheets';
import type { ChartSpec, ChartSpecChange, InlineChartData, RangeChartData } from '../../types/chart';
import { CHART_SPEC_PART_KEYS, CHART_SPEC_PARTS, CHART_STACKINGS, CHART_TYPES } from '../../types/chart';
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

describe('the shape', () => {
    test('a spec is eight parts, each a record', () => {
        const spec = sampleChartSpec('column');
        expect(Object.keys(spec).sort()).toEqual(Object.keys(CHART_SPEC_PARTS).sort());
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

    test('leaves the stored spec it was given, and the values it sets, as they were', () => {
        const { stored: before } = readChartSpec(JSON.stringify(raw));
        const value = { color: '#eb6834' };
        applyChartSpecChange(before, [
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
            { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
            { op: 'set', path: ['points', 's-1', '3'], value },
            { op: 'set', path: ['points', 's-1', '3', 'color'], value: '#2a78d6' },
        ]);
        expect(before).toEqual(raw);
        expect(value).toEqual({ color: '#eb6834' });
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

    // An xlsx pie can store a point on every slice, and each row op moves them all.
    test('applies a move of every point in linear time', () => {
        const shift = (i: number) => (i === 0 ? null : i - 1);
        const applying = (count: number) => {
            const stored = points(Object.fromEntries(Array.from({ length: count }, (_, i) => [i, '#000000'])));
            const change = chartPointMoves(stored, shift);
            return () => applyChartSpecChange(stored, change);
        };
        const fastest = (run: () => unknown) =>
            Math.min(
                ...Array.from({ length: 7 }, () => {
                    const start = performance.now();
                    run();
                    return performance.now() - start;
                }),
            );
        // Timed against a tenth of the points, so load slows both: linear is about 10x, a copy per move 100x.
        expect(fastest(applying(MAX_CHART_POINTS))).toBeLessThan(30 * fastest(applying(MAX_CHART_POINTS / 10)));
        const after = moved(
            Object.fromEntries(Array.from({ length: MAX_CHART_POINTS }, (_, i) => [i, '#000000'])),
            shift,
        );
        expect(Object.keys(after)).toHaveLength(MAX_CHART_POINTS - 1);
        expect(after[MAX_CHART_POINTS - 2]).toEqual({ color: '#000000', future: String(MAX_CHART_POINTS - 1) });
    });

    test('only a stored point moves, and an index that stays writes nothing', () => {
        expect(moved({ 1: '#000001' }, (i) => (i === 0 ? 1 : null))).toEqual({});
        expect(chartPointMoves(points({ 0: '#000000', 1: '#000001', 2: '#000002' }), (i) => i)).toEqual([]);
    });
});

describe('the stored parts', () => {
    const styled = chart({
        series: {
            ...chart().series,
            's-2': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' },
        },
        points: { 's-1': { 3: { color: '#eb6834' } } },
    });
    const parts = (patch: Record<string, unknown> = {}) => ({ ...newChartSpecParts(styled), ...patch });
    const sheet = (patch: Record<string, unknown> = {}) => ({ ...newSheetChartSpecParts(styled), ...patch });
    const point = JSON.stringify({ color: '#eb6834' });

    test('a part per key, spec and its name, every key of the spec a part', () => {
        expect(Object.keys(CHART_SPEC_PARTS)).toEqual(Object.keys(sampleChartSpec('column')));
        const capitalized = Object.keys(CHART_SPEC_PARTS).map((part) => `spec${upperFirst(part)}`);
        expect(capitalized).toEqual(CHART_SPEC_PART_KEYS);
        expect(['specChart', 'specFuture'].map(isChartSpecKey)).toEqual([true, true]);
        expect(['spec', 'special', 'chart'].map(isChartSpecKey)).toEqual([false, false, false]);
    });

    test('a spec round-trips through its parts, a string each or Sheets entries', () => {
        for (const type of CHART_TYPES) {
            const spec = { ...styled, chart: { ...styled.chart, type } };
            expect(readChartSpec(newChartSpecParts(spec)).spec).toEqual(spec);
            expect(readChartSpec(newSheetChartSpecParts(spec)).spec).toEqual(spec);
        }
    });

    test("a new chart's parts hold every keyed part, empty if it has no entries", () => {
        const spec = chart();
        const strings = newChartSpecParts(spec);
        expect(Object.keys(strings)).toEqual([...CHART_SPEC_PART_KEYS]);
        expect(strings.specPoints).toBe('{}');
        const entries = newSheetChartSpecParts(spec);
        expect(Object.keys(entries)).toEqual([...CHART_SPEC_PART_KEYS]);
        expect(entries.specPoints).toEqual({});
    });

    test('Sheets stores a keyed part an entry per axis, plot type, series and point, its path / -joined', () => {
        const entries = newSheetChartSpecParts(styled);
        expect(entries.specTitle).toBe(JSON.stringify(styled.title));
        expect(Object.keys(entries.specAxes)).toEqual(['x', 'y']);
        expect(Object.keys(entries.specPlots)).toEqual([...CHART_TYPES]);
        expect(entries.specSeries['s-2']).toBe(JSON.stringify(styled.series['s-2']));
        expect(entries.specPoints).toEqual({ 's-1/3': point });
    });

    test('a write is the parts the change touched, as strings', () => {
        const { stored } = readChartSpec(parts());
        expect(chartSpecWrites(stored, [{ op: 'set', path: ['title', 'text'], value: 'New' }])).toEqual({
            specTitle: JSON.stringify({ text: 'New' }),
        });
        const writes = chartSpecWrites(stored, [
            { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
            { op: 'set', path: ['points', 's-2', '0', 'color'], value: '#000000' },
        ]);
        expect(Object.keys(writes)).toEqual(['specAxes', 'specPoints']);
        expect(JSON.parse(writes.specPoints ?? '')).toEqual({ ...styled.points, 's-2': { 0: { color: '#000000' } } });
    });

    test('a Sheets write is the entries the change touched, never a keyed record whole', () => {
        const { stored } = readChartSpec(sheet());
        const scale = { ...styled.axes.y.scale, min: 0 };
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['title', 'text'], value: 'New' },
                { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
                { op: 'set', path: ['plots', 'bar', 'stacking'], value: 'percent' },
                { op: 'set', path: ['series', 's-2', 'color'], value: null },
                { op: 'move', from: ['points', 's-1', '3'], path: ['points', 's-1', '2'] },
            ]),
        ).toEqual([
            { key: 'specTitle', value: JSON.stringify({ text: 'New' }) },
            { key: 'specAxes', entry: 'y', value: JSON.stringify({ ...styled.axes.y, scale }) },
            { key: 'specPlots', entry: 'bar', value: JSON.stringify({ stacking: 'percent' }) },
            { key: 'specSeries', entry: 's-2', value: JSON.stringify(DEFAULT_CHART_SERIES_STYLE) },
            { key: 'specPoints', entry: 's-1/3', value: null },
            { key: 'specPoints', entry: 's-1/2', value: point },
        ]);
    });

    test("a first entry write ships one entry, not its record, and a part's whole set ships its entries", () => {
        const { stored } = readChartSpec(newSheetChartSpecParts(chart()));
        expect(
            sheetChartSpecWrites(stored, [{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]),
        ).toEqual([{ key: 'specPoints', entry: 's-1/3', value: point }]);
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['points'], value: { 's-1': { 3: { color: '#eb6834' } } } },
            ]),
        ).toEqual([{ key: 'specPoints', entry: 's-1/3', value: point }]);
    });

    test('a remove of what is not stored writes nothing', () => {
        const removes: ChartSpecChange = [
            { op: 'remove', path: ['points', 's-1', '5'] },
            { op: 'remove', path: ['points', 's-3', '0'] },
            { op: 'move', from: ['points', 's-2', '1'], path: ['points', 's-2', '0'] },
        ];
        expect(chartSpecWrites(readChartSpec(parts()).stored, removes)).toEqual({});
        expect(sheetChartSpecWrites(readChartSpec(sheet()).stored, removes)).toEqual([]);
    });

    test("a set to the stored value writes nothing, so a peer's edit of another entry in that part stands", () => {
        const same: ChartSpecChange = [
            { op: 'set', path: ['series', 's-1', 'color'], value: null },
            { op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' },
            { op: 'set', path: ['title', 'text'], value: styled.title.text },
        ];
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-2', 'color'], value: '#000000' }];
        const base = parts();
        const { stored } = readChartSpec(base);
        expect(chartSpecWrites(stored, same)).toEqual({});
        const both = { ...base, ...chartSpecWrites(stored, recolor), ...chartSpecWrites(stored, same) };
        expect(readChartSpec(both).spec?.series['s-2'].color).toBe('#000000');
        expect(sheetChartSpecWrites(readChartSpec(sheet()).stored, same)).toEqual([]);
    });

    test('a Sheets write is never an entry key the reader ignores', () => {
        const { stored } = readChartSpec(sheet());
        expect(
            sheetChartSpecWrites(stored, [
                { op: 'set', path: ['points', 's-1', '03', 'color'], value: '#000000' },
                { op: 'set', path: ['points', 's-1', '1e3', 'color'], value: '#000000' },
            ]),
        ).toEqual([]);
    });

    test("a series delete writes the data alone, and the next write of series or points drops the gone series' entries", () => {
        const [first, second] = styled.data.series;
        const deleteSecond: ChartSpecChange = [{ op: 'set', path: ['data', 'series'], value: [first] }];
        const recolor: ChartSpecChange = [{ op: 'set', path: ['series', 's-1', 'color'], value: '#000000' }];
        const strings = parts(chartSpecWrites(readChartSpec(parts()).stored, deleteSecond));
        expect(strings).toEqual(parts({ specData: JSON.stringify({ ...styled.data, series: [first] }) }));
        const recolored = chartSpecWrites(readChartSpec(strings).stored, recolor);
        expect(Object.keys(recolored)).toEqual(['specSeries']);
        expect(Object.keys(JSON.parse(recolored.specSeries ?? ''))).toEqual(['s-1']);

        const firstTwo = sheet({ specData: JSON.stringify({ ...styled.data, series: [first, second] }) });
        expect(sheetChartSpecWrites(readChartSpec(firstTwo).stored, recolor)).toEqual([
            { key: 'specSeries', entry: 's-1', value: JSON.stringify({ ...styled.series['s-1'], color: '#000000' }) },
            { key: 'specSeries', entry: 's-3', value: null },
        ]);
        const secondOnly = sheet({ specData: JSON.stringify({ ...styled.data, series: [second] }) });
        const repoint: ChartSpecChange = [{ op: 'set', path: ['points', 's-2', '0', 'color'], value: '#000000' }];
        expect(sheetChartSpecWrites(readChartSpec(secondOnly).stored, repoint)).toEqual([
            { key: 'specPoints', entry: 's-1/3', value: null },
            { key: 'specPoints', entry: 's-2/0', value: JSON.stringify({ color: '#000000' }) },
        ]);
    });

    test('a broken presentation part reads its default, and broken data resolves no spec but keeps the rest', () => {
        const defaults = defaultChartSpec('column', styled.data);
        for (const read of [parts, sheet]) {
            const broken = readChartSpec(read({ specLegend: '{', specTitle: '[1]', specAxes: '"x"' }));
            expect(broken.spec).toEqual({
                ...styled,
                legend: defaults.legend,
                title: defaults.title,
                axes: defaults.axes,
            });
            expect([broken.stored.legend, broken.stored.title, broken.stored.axes]).toEqual([undefined, undefined, {}]);
            const noData = readChartSpec(read({ specData: '{' }));
            expect(noData.spec).toBeNull();
            expect(noData.stored.data).toBeUndefined();
            expect(noData.stored.chart).toEqual(styled.chart);
        }
    });

    test('a part nested past the depth limit reads as broken, in a string and in an entry', () => {
        const deep = `${'['.repeat(MAX_CHART_SPEC_DEPTH + 1)}${']'.repeat(MAX_CHART_SPEC_DEPTH + 1)}`;
        const deepEntry = `{"color":${deep}}`;
        expect(readChartSpec(parts({ specLegend: deep })).stored.legend).toBeUndefined();
        const { stored, spec } = readChartSpec(sheet({ specPoints: { 's-1/3': deepEntry, 's-1/4': point } }));
        expect(stored.points).toEqual({ 's-1': { 4: { color: '#eb6834' } } });
        expect(spec?.points).toEqual({ 's-1': { 4: { color: '#eb6834' } } });
    });

    test('a missing keyed record reads as empty', () => {
        const { specAxes, specPoints, ...rest } = sheet();
        const { stored, spec } = readChartSpec(rest);
        expect([stored.axes, stored.points]).toEqual([{}, {}]);
        expect(spec).toEqual({ ...styled, axes: defaultChartSpec('column', styled.data).axes, points: {} });
    });

    test('an entry key that is no path is ignored, and the other entries read', () => {
        const specPoints = Object.fromEntries(
            [
                's-1/1',
                's-1',
                '12',
                's-1/3/4',
                's-1/-1',
                's-1/1e3',
                's-1/03',
                `s-1/${MAX_CHART_POINTS}`,
                '/1',
                'a b/1',
            ].map((key) => [key, point]),
        );
        const specSeries = { ...sheet().specSeries, 'a/b': '{}', ['__proto__']: '{}' };
        const { stored, spec } = readChartSpec(sheet({ specPoints, specSeries }));
        expect(stored.points).toEqual({ 's-1': { 1: { color: '#eb6834' } } });
        expect(spec?.points).toEqual({ 's-1': { 1: { color: '#eb6834' } } });
        expect(Object.keys(stored.series ?? {})).toEqual(['s-1', 's-2', 's-3']);
    });

    test('past the limit summed over every prefixed key, unknown ones and Sheets entries too, nothing is read or parsed', () => {
        const bytes = (texts: unknown[]): number =>
            texts.reduce<number>(
                (sum, text) =>
                    sum +
                    (typeof text === 'string'
                        ? new TextEncoder().encode(text).length
                        : bytes(Object.entries(text ?? {}).flat())),
                0,
            );
        const left = MAX_CHART_SPEC_BYTES - bytes(Object.entries(parts({ specFuture: '' })).flat());
        const half = Math.ceil((MAX_CHART_SPEC_BYTES - bytes(Object.entries(sheet()).flat())) / 2);
        const parse = spyOn(JSON, 'parse');
        try {
            for (const over of [
                parts({ specFuture: 'x'.repeat(left + 1) }),
                parts({ specFuture: 'é'.repeat(Math.ceil(left / 2) + 1) }),
                sheet({ specFuture: { a: 'x'.repeat(half), b: 'x'.repeat(half) } }),
            ]) {
                expect(readChartSpec(over)).toEqual({ stored: {}, spec: null });
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        expect(readChartSpec(parts({ specFuture: 'x'.repeat(left) })).spec).toEqual(styled);
        expect(readChartSpec(parts({ future: 'x'.repeat(MAX_CHART_SPEC_BYTES) })).spec).toEqual(styled);
    });

    test('the count stops at the limit, so a million forged points measure about 6,000', () => {
        const target = Object.fromEntries(Array.from({ length: 1_000_000 }, (_, i) => [`s-1/${i}`, '{}']));
        let reads = 0;
        const specPoints = new Proxy(target, {
            get: (entries, key, receiver) => {
                reads += 1;
                return Reflect.get(entries, key, receiver);
            },
        });
        expect(readChartSpec(sheet({ specPoints }))).toEqual({ stored: {}, spec: null });
        expect(reads).toBeGreaterThan(1000);
        expect(reads).toBeLessThan(10_000);
    });

    test("every prefixed key's name counts, so a million forged empty keys measure a few thousand", () => {
        const target = {
            ...sheet(),
            ...Object.fromEntries(Array.from({ length: 1_000_000 }, (_, i) => [`specF${i}`, ''])),
        };
        let reads = 0;
        const forged = new Proxy(target, {
            get: (entries, key, receiver) => {
                reads += 1;
                return Reflect.get(entries, key, receiver);
            },
        });
        expect(readChartSpec(forged)).toEqual({ stored: {}, spec: null });
        expect(reads).toBeLessThan(15_000);
    });
});
