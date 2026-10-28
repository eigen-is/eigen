import { describe, expect, test } from 'bun:test';
import {
    chartPointIndex,
    chartSearchText,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    holdsUnknownChartData,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    MAX_CHART_SPEC_BYTES,
    parseChartSpec,
    sampleChartSpec,
} from '../../charts';
import { EIGEN_FONT_NAMES } from '../../constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../../sheets';
import type { InlineChartData, StoredChartSpec } from '../../types/chart';
import { CHART_STACKINGS } from '../../types/chart';
import { chart, inlineData, rangeData, stored } from './spec-fixtures';

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

    test("a series' data labels show only when stored as true, a pie's spec included", () => {
        const visible = (labels: unknown, type = 'column') =>
            parseChartSpec(stored({ chart: { type }, series: { 's-1': { labels } } }))?.series['s-1'].labels.visible;
        expect(parseChartSpec(stored({}))?.series['s-1'].labels).toEqual({ visible: false });
        expect(visible({ visible: true })).toBe(true);
        expect(visible({ visible: false })).toBe(false);
        for (const junk of ['yes', 1, { on: true }, null]) expect(visible({ visible: junk })).toBe(false);
        expect(visible(true)).toBe(false);
        expect(visible({ visible: true }, 'pie')).toBe(true);
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

describe('holdsUnknownChartData', () => {
    const read = (raw: object) => {
        const storedSpec: StoredChartSpec = JSON.parse(JSON.stringify(raw));
        const spec = parseChartSpec(JSON.stringify(raw));
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
