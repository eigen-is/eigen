import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    FLAT_CHART_LOOK,
    parseChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type {
    CellRangeRef,
    ChartData,
    ChartSeriesStyle,
    ChartSpec,
    ChartStacking,
    ChartType,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import type { XmlElement } from '../../lib/core/xml';
import { hasXmlName, xmlAttr, xmlElements, xmlTrimmedText } from '../../lib/core/xml';
import type { DrawingTheme } from '../../lib/ooxml/drawingml';
import { IDENTITY_COLOR_MAP } from '../../lib/ooxml/drawingml';
import { A_NS, C_NS, parseOoxml } from '../../lib/ooxml/ooxml';
import { readChart } from '../../lib/ooxml/ooxml-chart';
import { writeChart } from '../../lib/ooxml/ooxml-chart-writer';
import { seriesIdsByPlace } from '../../scripts/office-audit';

// A ChartSpec written as a c:chartSpace and read back by Eigen's own reader: the same spec, its ranges by the names the
// workbook writes and its numbers inline as literals.

const theme: DrawingTheme = { scheme: new Map(), map: IDENTITY_COLOR_MAP };
const NAMES = new Map([
    ['s1', 'Data'],
    ['s2', "Bob's <sheet>"],
]);
const ranges = (sheetId: string) => NAMES.get(sheetId);
// Inline data names no sheet.
const INLINE = { ranges: () => undefined, look: FLAT_CHART_LOOK };
const ids = (name: string) => [...NAMES].find(([, written]) => written === name)?.[0];

const ref = (row: [number, number], column: [number, number], sheetId = 's1'): CellRangeRef => ({
    sheetId,
    row,
    column,
});

function parsed(spec: unknown): ChartSpec {
    const read = parseChartSpec(JSON.stringify(spec));
    if (!read) throw new Error('the spec does not parse');
    return read;
}

const styled = (color: string | null, more: Partial<ChartSeriesStyle> = {}): ChartSeriesStyle => ({
    ...DEFAULT_CHART_SERIES_STYLE,
    color,
    ...more,
});

// What a test sets over the defaults; chart and axes merge into theirs.
type SpecOver = Partial<Omit<ChartSpec, 'chart' | 'axes' | 'data'>> & {
    chart?: Partial<ChartSpec['chart']>;
    axes?: Partial<ChartSpec['axes']>;
};

// Categories down A2:A4, a series named by B1 over B2:B4 and one named in the spec over Bob's C2:C4.
function rangeSpec(type: ChartType, over: SpecOver = {}, series: RangeChartSeries[] = RANGE_SERIES): ChartSpec {
    const data: RangeChartData = { source: 'range', categories: ref([1, 3], [0, 0]), series };
    const defaults = defaultChartSpec(type, data);
    return parsed({
        ...defaults,
        series: RANGE_STYLES,
        ...over,
        chart: { ...defaults.chart, ...over.chart },
        axes: { ...defaults.axes, ...over.axes },
    });
}

const RANGE_SERIES: RangeChartSeries[] = [
    { id: 's-1', name: ref([0, 0], [1, 1]), values: ref([1, 3], [1, 1]) },
    { id: 's-2', name: 'Plan', values: ref([1, 3], [2, 2], 's2') },
];
const RANGE_STYLES: ChartSpec['series'] = { 's-2': styled('#112233') };

const DEFAULT_AXES = defaultChartSpec('column', { source: 'inline', categories: [], series: [] }).axes;
const stacked = (type: ChartType, stacking: ChartStacking): SpecOver => ({
    plots: { ...defaultChartSpec(type, { source: 'inline', categories: [], series: [] }).plots, [type]: { stacking } },
});

function root(xml: string): XmlElement {
    const element = parseOoxml(xml);
    if (!element) throw new Error('not XML');
    return element;
}

function read(xml: string, data: Parameters<typeof readChart>[1]['data']): ChartSpec {
    const result = readChart(root(xml), { theme, data });
    if (!('spec' in result)) throw new Error(`unsupported: ${JSON.stringify(result.unsupported)}`);
    return seriesIdsByPlace(result.spec);
}

const throughRanges = (spec: ChartSpec, cache?: ChartData) =>
    read(writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK }), { ranges: ids });

// A pie has no axes, so the axis fields a Type switch would show read as an Excel pie's: no titles, no gridlines.
function axesOf(spec: ChartSpec): ChartSpec {
    if (spec.chart.type !== 'pie') return spec;
    const { x, y } = DEFAULT_AXES;
    return { ...spec, axes: { x, y: { ...y, gridlines: { visible: false } } } };
}

// Every element named `local` in the chart namespace, depth first.
function find(element: XmlElement, local: string, ns = C_NS): XmlElement[] {
    const found = hasXmlName(element, ns, local) ? [element] : [];
    return [...found, ...xmlElements(element).flatMap((child) => find(child, local, ns))];
}

const val = (element: XmlElement | undefined, local: string) => {
    const [found] = element ? find(element, local) : [];
    return found && xmlAttr(found, '', 'val');
};

describe('writeChart with range data', () => {
    test.each([
        ['column', 'none'],
        ['column', 'stacked'],
        ['column', 'percent'],
        ['bar', 'none'],
        ['bar', 'stacked'],
        ['bar', 'percent'],
    ] as const)("a %s chart stacked '%s' reads back as itself", (type, stacking) => {
        const spec = rangeSpec(type, stacked(type, stacking));
        expect(throughRanges(spec)).toEqual(spec);
    });

    test('a percent-stacked chart labels its value axis 0%, which reads back as no format', () => {
        const spec = rangeSpec('column', stacked('column', 'percent'));
        const [axis] = find(root(writeChart(spec, { ranges, look: FLAT_CHART_LOOK })), 'valAx');
        const [numFmt] = find(axis, 'numFmt');
        expect([xmlAttr(numFmt, '', 'formatCode'), xmlAttr(numFmt, '', 'sourceLinked')]).toEqual(['0%', '0']);
        expect(throughRanges(spec).axes.y.labels.format).toBeNull();
    });

    test('a percent-stacked chart keeps a format of its own', () => {
        const spec = rangeSpec('column', stacked('column', 'percent'));
        const own = { ...spec, axes: { ...spec.axes, y: { ...spec.axes.y, labels: { format: '0.0%' } } } };
        expect(throughRanges(own).axes.y.labels.format).toBe('0.0%');
    });

    test('a line chart keeps its markers and smooth lines', () => {
        const series = {
            's-1': styled(null, { marker: { visible: true }, line: { smooth: true } }),
            's-2': styled('#112233'),
        };
        const spec = rangeSpec('line', { series });
        expect(throughRanges(spec)).toEqual(spec);
    });

    test("a pie writes its first series' points as c:dPt fills, an absent one automatic, and reads them back", () => {
        const spec = rangeSpec('pie', { points: { 's-1': { 1: { color: '#abcdef' } } } }, RANGE_SERIES.slice(0, 1));
        const cache: ChartData = {
            categories: ['North', 'South', 'East'],
            series: [{ id: 's-1', name: 'Sales', values: [1, 2, 3] }],
        };
        const xml = writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK });
        expect(throughRanges(spec, cache)).toEqual(axesOf(spec));
        expect(throughRanges(spec, cache).points).toEqual({ 's-1': { 1: { color: '#abcdef' } } });
        // Excel draws the palette's colour for the automatic slices, explicitly.
        const colors = find(root(xml), 'dPt').map((point) => find(point, 'srgbClr', A_NS)[0]);
        expect(colors.map((color) => xmlAttr(color, '', 'val'))).toEqual([
            chartColor(0).slice(1).toUpperCase(),
            'ABCDEF',
            chartColor(2).slice(1).toUpperCase(),
        ]);
    });

    test('titles, legend, blanks and both axes read back, every option off its default', () => {
        const { x, y } = DEFAULT_AXES;
        for (const legend of ['top', 'bottom', 'left', 'right', 'none'] as const) {
            const spec = rangeSpec('column', {
                title: { text: 'Sales & <costs>' },
                legend: { position: legend },
                chart: { blanks: 'span', fontFamily: 'Source Serif' },
                axes: {
                    x: { ...x, title: { text: 'Region' }, visible: false, scale: { ...x.scale, reversed: true } },
                    y: {
                        ...y,
                        title: { text: 'Euro' },
                        scale: { min: -5, max: 12.5, reversed: false },
                        gridlines: { visible: false },
                        labels: { format: '#,##0.0' },
                        visible: false,
                    },
                },
            });
            expect(throughRanges(spec)).toEqual(spec);
        }
        const reversed = { ...x, scale: { ...x.scale, reversed: true } };
        const zero = rangeSpec('line', { chart: { blanks: 'zero' }, axes: { x: reversed } });
        expect(throughRanges(zero)).toEqual(zero);
    });

    test('a picked colour keeps its alpha, and an automatic one is written as its palette colour', () => {
        const series = [RANGE_SERIES[0], RANGE_SERIES[1], { ...RANGE_SERIES[1], id: 's-3' }];
        const spec = rangeSpec('column', { series: { 's-2': styled('#11223380') } }, series);
        const xml = writeChart(spec, { ranges, look: FLAT_CHART_LOOK });
        const back = throughRanges(spec);
        expect(back.data.series.map(({ id }) => back.series[id]?.color)).toEqual([null, '#11223380', null]);
        const fills = find(root(xml), 'ser').map((ser) => xmlAttr(find(ser, 'srgbClr', A_NS)[0], '', 'val'));
        expect(fills).toEqual([chartColor(0), '#112233', chartColor(2)].map((color) => color.slice(1).toUpperCase()));
    });

    // CHARTS.md: c:orientation is maxMin when (type === 'bar') !== reversed, and the value axis crosses at that end.
    test("the category axis runs as Google's unless reversed, the value axis staying at its start", () => {
        const orientation = (spec: ChartSpec) => {
            const chart = root(writeChart(spec, { ranges, look: FLAT_CHART_LOOK }));
            return [val(find(chart, 'catAx')[0], 'orientation'), val(find(chart, 'valAx')[0], 'crosses')];
        };
        expect(orientation(rangeSpec('column'))).toEqual(['minMax', 'autoZero']);
        expect(orientation(rangeSpec('bar'))).toEqual(['maxMin', 'max']);
        const { x } = DEFAULT_AXES;
        const reversed = { axes: { x: { ...x, scale: { ...x.scale, reversed: true } } } };
        expect(orientation(rangeSpec('column', reversed))).toEqual(['maxMin', 'max']);
        expect(orientation(rangeSpec('bar', reversed))).toEqual(['minMax', 'autoZero']);
    });

    test("refs name the workbook's sheets quoted, and a sheet it doesn't write is #REF!", () => {
        const xml = writeChart(rangeSpec('column'), { ranges, look: FLAT_CHART_LOOK });
        expect(find(root(xml), 'f').map(xmlTrimmedText)).toEqual([
            "'Data'!$B$1",
            "'Data'!$A$2:$A$4",
            "'Data'!$B$2:$B$4",
            "'Data'!$A$2:$A$4",
            "'Bob''s <sheet>'!$C$2:$C$4",
        ]);
        const lost = read(
            writeChart(rangeSpec('column'), {
                ranges: (id) => (id === 's1' ? 'Data' : undefined),
                look: FLAT_CHART_LOOK,
            }),
            {
                ranges: ids,
            },
        );
        expect(lost.data.series[1]).toMatchObject({ name: 'Plan', values: null });
    });

    test('a series whose values were deleted is written without them, its colour kept', () => {
        const series = [{ ...RANGE_SERIES[0], values: null }, RANGE_SERIES[1]];
        const spec = rangeSpec('column', { series: { ...RANGE_STYLES, 's-1': styled('#445566') } }, series);
        expect(throughRanges(spec)).toEqual(spec);
    });

    test("the caches hold what the cells show, each series' beside its refs", () => {
        const series = { ...RANGE_STYLES, 's-3': styled('#112233') };
        const spec = rangeSpec('column', { series }, [
            RANGE_SERIES[0],
            { ...RANGE_SERIES[1], values: null },
            { ...RANGE_SERIES[1], id: 's-3', name: 'Actual' },
        ]);
        const cache: ChartData = {
            categories: ['North', 'South', 'East'],
            series: [
                { id: 's-1', name: 'Sales', values: [1, null, 3] },
                { id: 's-3', name: 'Actual', values: [4.5, 5, -6e-7] },
            ],
        };
        const inline = read(writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK }), 'cache');
        expect(inline.data).toEqual({
            source: 'inline',
            categories: ['North', 'South', 'East'],
            series: [
                { id: 's-1', name: 'Sales', values: [1, null, 3] },
                { id: 's-2', name: 'Plan', values: [] },
                { id: 's-3', name: 'Actual', values: [4.5, 5, -6e-7] },
            ],
        });
        expect(inline.series).toEqual({ 's-1': DEFAULT_CHART_SERIES_STYLE, ...series });
        expect(throughRanges(spec, cache)).toEqual(spec);
    });

    test('without caches the refs go alone, and the chart still reads back', () => {
        const xml = writeChart(rangeSpec('column'), { ranges, look: FLAT_CHART_LOOK });
        expect(find(root(xml), 'numCache')).toEqual([]);
        expect(throughRanges(rangeSpec('column'))).toEqual(rangeSpec('column'));
    });

    test('the same spec writes the same bytes', () => {
        const spec = rangeSpec('pie', {}, RANGE_SERIES.slice(0, 1));
        expect(writeChart(spec, { ranges, look: FLAT_CHART_LOOK })).toBe(
            writeChart(parsed(spec), { ranges, look: FLAT_CHART_LOOK }),
        );
        expect(throughRanges(spec)).toEqual(axesOf(spec));
    });
});

describe('writeChart with inline data', () => {
    test.each(['column', 'bar', 'line', 'pie'] as const)("the %s sample's literals read back as it", (type) => {
        const spec = sampleChartSpec(type);
        expect(read(writeChart(spec, INLINE), 'cache')).toEqual(axesOf(spec));
    });

    test('gaps, ragged series and no categories read back', () => {
        const spec = parsed(
            defaultChartSpec('line', {
                source: 'inline',
                categories: [],
                series: [
                    { id: 's-1', name: '', values: [1, null, 3, null] },
                    { id: 's-2', name: 'Two', values: [] },
                ],
            }),
        );
        expect(read(writeChart(spec, INLINE), 'cache')).toEqual(spec);
    });

    test('a literal read through ranges reads as its literals', () => {
        const spec = sampleChartSpec('column');
        expect(read(writeChart(spec, INLINE), { ranges: ids })).toEqual(spec);
    });
});
