import { describe, expect, test } from 'bun:test';
import {
    chartColor,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartPresentation,
    parseChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { CellRangeRef, ChartData, ChartSpec, ChartType, RangeChartSeries } from '@workspace/lib/types/chart';
import { type DrawingTheme, IDENTITY_COLOR_MAP } from '../../lib/core/drawingml';
import { A_NS, C_NS, parseOoxml } from '../../lib/core/ooxml';
import { readChart } from '../../lib/core/ooxml-chart';
import { writeChart } from '../../lib/core/ooxml-chart-writer';
import { hasXmlName, type XmlElement, xmlAttr, xmlElements, xmlTrimmedText } from '../../lib/core/xml';

// A ChartSpec written as a c:chartSpace and read back by Eigen's own reader: the same spec, its ranges by the names the
// workbook writes and its numbers inline as literals.

const theme: DrawingTheme = { scheme: new Map(), map: IDENTITY_COLOR_MAP };
const NAMES = new Map([
    ['s1', 'Data'],
    ['s2', "Bob's <sheet>"],
]);
const ranges = (sheetId: string) => NAMES.get(sheetId);
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

// Categories down A2:A4, a series named by B1 over B2:B4 and one named in the spec over Bob's C2:C4.
function rangeSpec(
    type: ChartType,
    over: Partial<ChartSpec> = {},
    series: RangeChartSeries[] = RANGE_SERIES,
): ChartSpec {
    return parsed({
        ...defaultChartPresentation(type),
        type,
        ...over,
        data: { source: 'range', categories: ref([1, 3], [0, 0]), series },
    });
}

const RANGE_SERIES: RangeChartSeries[] = [
    { ...DEFAULT_CHART_SERIES_STYLE, name: ref([0, 0], [1, 1]), values: ref([1, 3], [1, 1]) },
    { ...DEFAULT_CHART_SERIES_STYLE, color: '#112233', name: 'Plan', values: ref([1, 3], [2, 2], 's2') },
];

function root(xml: string): XmlElement {
    const element = parseOoxml(xml);
    if (!element) throw new Error('not XML');
    return element;
}

function read(xml: string, data: Parameters<typeof readChart>[1]['data']): ChartSpec {
    const result = readChart(root(xml), { theme, data });
    if (!('spec' in result)) throw new Error(`unsupported: ${JSON.stringify(result.unsupported)}`);
    return result.spec;
}

const throughRanges = (spec: ChartSpec, cache?: ChartData) =>
    read(writeChart(spec, { ranges, cache }), { ranges: ids });

// A pie has no axes, so the axis fields a Type switch would show read as an Excel pie's: no titles, no gridlines.
function axesOf(spec: ChartSpec): ChartSpec {
    if (spec.type !== 'pie') return spec;
    const { categoryAxis, valueAxis } = defaultChartPresentation('pie');
    return { ...spec, categoryAxis, valueAxis: { ...valueAxis, gridlines: false } };
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
        const spec = rangeSpec(type, { stacking });
        expect(throughRanges(spec)).toEqual(spec);
    });

    test('a percent-stacked chart labels its value axis 0%, which reads back as no format', () => {
        const spec = rangeSpec('column', { stacking: 'percent' });
        const [axis] = find(root(writeChart(spec, { ranges })), 'valAx');
        const [numFmt] = find(axis, 'numFmt');
        expect([xmlAttr(numFmt, '', 'formatCode'), xmlAttr(numFmt, '', 'sourceLinked')]).toEqual(['0%', '0']);
        expect(throughRanges(spec).valueAxis.format).toBeNull();
    });

    test('a percent-stacked chart keeps a format of its own', () => {
        const spec = rangeSpec('column', { stacking: 'percent' });
        const own = { ...spec, valueAxis: { ...spec.valueAxis, format: '0.0%' } };
        expect(throughRanges(own).valueAxis.format).toBe('0.0%');
    });

    test('a line chart keeps its markers and smooth lines', () => {
        const series = [
            { ...RANGE_SERIES[0], markers: true, smooth: true },
            { ...RANGE_SERIES[1], markers: false, smooth: false },
        ];
        const spec = rangeSpec('line', {}, series);
        expect(throughRanges(spec)).toEqual(spec);
    });

    test("a pie keeps its slice colours, an automatic one automatic, and its first series' look", () => {
        const spec = rangeSpec('pie', { sliceColors: [null, '#abcdef'] }, RANGE_SERIES.slice(0, 1));
        const xml = writeChart(spec, { ranges });
        expect(throughRanges(spec)).toEqual(axesOf(spec));
        // Excel draws the palette's colour for the automatic slices, explicitly.
        const colors = find(root(xml), 'dPt').map((point) => find(point, 'srgbClr', A_NS)[0]);
        expect(colors.map((color) => xmlAttr(color, '', 'val'))).toEqual([
            chartColor(0).slice(1).toUpperCase(),
            'ABCDEF',
            chartColor(2).slice(1).toUpperCase(),
        ]);
    });

    test('titles, legend, blanks and both axes read back, every option off its default', () => {
        for (const legend of ['top', 'bottom', 'left', 'right', 'none'] as const) {
            const spec = rangeSpec('column', {
                title: 'Sales & <costs>',
                legend,
                blanks: 'span',
                fontFamily: 'Source Serif',
                categoryAxis: { title: 'Region', visible: false, reversed: true },
                valueAxis: { title: 'Euro', min: -5, max: 12.5, gridlines: false, format: '#,##0.0', visible: false },
            });
            expect(throughRanges(spec)).toEqual(spec);
        }
        const zero = rangeSpec('line', { blanks: 'zero', categoryAxis: { title: '', visible: true, reversed: true } });
        expect(throughRanges(zero)).toEqual(zero);
    });

    test('a picked colour keeps its alpha, and an automatic one is written as its palette colour', () => {
        const series = [
            RANGE_SERIES[0],
            { ...RANGE_SERIES[1], color: '#11223380' },
            { ...RANGE_SERIES[1], color: null },
        ];
        const spec = rangeSpec('column', {}, series);
        const xml = writeChart(spec, { ranges });
        expect(throughRanges(spec).data.series.map((s) => s.color)).toEqual([null, '#11223380', null]);
        const fills = find(root(xml), 'ser').map((ser) => xmlAttr(find(ser, 'srgbClr', A_NS)[0], '', 'val'));
        expect(fills).toEqual([chartColor(0), '#112233', chartColor(2)].map((color) => color.slice(1).toUpperCase()));
    });

    // CHARTS.md: c:orientation is maxMin when (type === 'bar') !== reversed, and the value axis crosses at that end.
    test("the category axis runs as Google's unless reversed, the value axis staying at its start", () => {
        const orientation = (spec: ChartSpec) => {
            const chart = root(writeChart(spec, { ranges }));
            return [val(find(chart, 'catAx')[0], 'orientation'), val(find(chart, 'valAx')[0], 'crosses')];
        };
        expect(orientation(rangeSpec('column'))).toEqual(['minMax', 'autoZero']);
        expect(orientation(rangeSpec('bar'))).toEqual(['maxMin', 'max']);
        const reversed = { categoryAxis: { title: '', visible: true, reversed: true } };
        expect(orientation(rangeSpec('column', reversed))).toEqual(['maxMin', 'max']);
        expect(orientation(rangeSpec('bar', reversed))).toEqual(['minMax', 'autoZero']);
    });

    test("refs name the workbook's sheets quoted, and a sheet it doesn't write is #REF!", () => {
        const xml = writeChart(rangeSpec('column'), { ranges });
        expect(find(root(xml), 'f').map(xmlTrimmedText)).toEqual([
            "'Data'!$B$1",
            "'Data'!$A$2:$A$4",
            "'Data'!$B$2:$B$4",
            "'Data'!$A$2:$A$4",
            "'Bob''s <sheet>'!$C$2:$C$4",
        ]);
        const lost = read(writeChart(rangeSpec('column'), { ranges: (id) => (id === 's1' ? 'Data' : undefined) }), {
            ranges: ids,
        });
        expect(lost.data.series[1]).toMatchObject({ name: 'Plan', values: null });
    });

    test('a series whose values were deleted is written without them, its colour kept', () => {
        const series = [{ ...RANGE_SERIES[0], values: null, color: '#445566' }, RANGE_SERIES[1]];
        const spec = rangeSpec('column', {}, series);
        expect(throughRanges(spec)).toEqual(spec);
    });

    test("the caches hold what the cells show, each series' beside its refs", () => {
        const spec = rangeSpec('column', {}, [
            RANGE_SERIES[0],
            { ...RANGE_SERIES[1], values: null },
            { ...RANGE_SERIES[1], name: 'Actual' },
        ]);
        const cache: ChartData = {
            categories: ['North', 'South', 'East'],
            series: [
                { ...DEFAULT_CHART_SERIES_STYLE, color: chartColor(0), name: 'Sales', values: [1, null, 3] },
                { ...DEFAULT_CHART_SERIES_STYLE, color: '#112233', name: 'Actual', values: [4.5, 5, -6e-7] },
            ],
        };
        const inline = read(writeChart(spec, { ranges, cache }), 'cache');
        expect(inline.data).toEqual({
            source: 'inline',
            categories: ['North', 'South', 'East'],
            series: [
                { ...DEFAULT_CHART_SERIES_STYLE, name: 'Sales', values: [1, null, 3] },
                { ...DEFAULT_CHART_SERIES_STYLE, color: '#112233', name: 'Plan', values: [] },
                { ...DEFAULT_CHART_SERIES_STYLE, color: '#112233', name: 'Actual', values: [4.5, 5, -6e-7] },
            ],
        });
        expect(throughRanges(spec, cache)).toEqual(spec);
    });

    test('without caches the refs go alone, and the chart still reads back', () => {
        const xml = writeChart(rangeSpec('column'), { ranges });
        expect(find(root(xml), 'numCache')).toEqual([]);
        expect(throughRanges(rangeSpec('column'))).toEqual(rangeSpec('column'));
    });

    test('the same spec writes the same bytes', () => {
        const spec = rangeSpec('pie', {}, RANGE_SERIES.slice(0, 1));
        expect(writeChart(spec, { ranges })).toBe(writeChart(parsed(spec), { ranges }));
        expect(throughRanges(spec)).toEqual(axesOf(spec));
    });
});

describe('writeChart with inline data', () => {
    test.each(['column', 'bar', 'line', 'pie'] as const)("the %s sample's literals read back as it", (type) => {
        const spec = sampleChartSpec(type);
        expect(read(writeChart(spec), 'cache')).toEqual(axesOf(spec));
    });

    test('gaps, ragged series and no categories read back', () => {
        const spec = parsed({
            ...defaultChartPresentation('line'),
            type: 'line',
            data: {
                source: 'inline',
                categories: [],
                series: [
                    { ...DEFAULT_CHART_SERIES_STYLE, name: '', values: [1, null, 3, null] },
                    { ...DEFAULT_CHART_SERIES_STYLE, name: 'Two', values: [] },
                ],
            },
        });
        expect(read(writeChart(spec), 'cache')).toEqual(spec);
    });

    // An xlsx reads its refs first and falls back to the caches for a literal.
    test("a literal can't be read as a range", () => {
        expect(readChart(root(writeChart(sampleChartSpec('column'))), { theme, data: { ranges: ids } })).toEqual({
            unsupported: { title: "Where a star's light goes", name: 'Clustered Column' },
        });
    });
});
