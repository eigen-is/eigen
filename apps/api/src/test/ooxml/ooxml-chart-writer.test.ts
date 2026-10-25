import { describe, expect, test } from 'bun:test';
import { gradientStops } from '@workspace/lib/background';
import {
    CHART_TITLE_SCALE,
    chartColor,
    chartFontSize,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    FLAT_CHART_LOOK,
    parseChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type {
    CellRangeRef,
    ChartData,
    ChartLook,
    ChartSeriesStyle,
    ChartSpec,
    ChartStacking,
    ChartType,
    InlineChartSeries,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import { serializeFill, solidFill, TRANSPARENT_COLOR } from '@workspace/lib/vector';
import type { XmlElement } from '../../lib/core/xml';
import { hasXmlName, xmlAttr, xmlElements, xmlTrimmedText } from '../../lib/core/xml';
import type { DrawingTheme } from '../../lib/ooxml/drawingml';
import { IDENTITY_COLOR_MAP } from '../../lib/ooxml/drawingml';
import { A_NS, C_NS, EMU_PER_PX, parseOoxml, R_NS } from '../../lib/ooxml/ooxml';
import type { ChartHost } from '../../lib/ooxml/ooxml-chart';
import { readChart, readChartPartLook } from '../../lib/ooxml/ooxml-chart';
import { chartGraphicXml, embeddedChartSheet, writeChart } from '../../lib/ooxml/ooxml-chart-writer';
import { seriesIdsByPlace } from '../../scripts/office-audit';
import { axesOf } from '../fixtures/chart-parts';
import { refsAgainstCells } from '../fixtures/chart-workbook';

// A ChartSpec written as a c:chartSpace and read back by Eigen's own reader: the same spec, its ranges by the names the
// workbook writes and its numbers inline as literals.

const theme: DrawingTheme = { scheme: new Map(), map: IDENTITY_COLOR_MAP };
const NAMES = new Map([
    ['s1', 'Data'],
    ['s2', "Bob's <sheet>"],
]);
const ranges = (sheetId: string) => NAMES.get(sheetId);
// The sample's box on a page, where one px is EMU_PER_PX.
const FRAME = { width: 600, height: 371, emuPerPx: EMU_PER_PX };
// Inline data names no sheet.
const INLINE = { look: FLAT_CHART_LOOK, frame: FRAME };
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
    read(writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK, frame: FRAME }), { ranges: ids });

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
        const [axis] = find(root(writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME })), 'valAx');
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
        const xml = writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK, frame: FRAME });
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
        const xml = writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME });
        const back = throughRanges(spec);
        expect(back.data.series.map(({ id }) => back.series[id]?.color)).toEqual([null, '#11223380', null]);
        const fills = find(root(xml), 'ser').map((ser) => xmlAttr(find(ser, 'srgbClr', A_NS)[0], '', 'val'));
        expect(fills).toEqual([chartColor(0), '#112233', chartColor(2)].map((color) => color.slice(1).toUpperCase()));
    });

    // CHARTS.md: c:orientation is maxMin when (type === 'bar') !== reversed, and the value axis crosses at that end.
    test("the category axis runs as Google's unless reversed, the value axis staying at its start", () => {
        const orientation = (spec: ChartSpec) => {
            const chart = root(writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME }));
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
        const xml = writeChart(rangeSpec('column'), { ranges, look: FLAT_CHART_LOOK, frame: FRAME });
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
                frame: FRAME,
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
        const inline = read(writeChart(spec, { ranges, cache, look: FLAT_CHART_LOOK, frame: FRAME }), 'cache');
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
        const xml = writeChart(rangeSpec('column'), { ranges, look: FLAT_CHART_LOOK, frame: FRAME });
        expect(find(root(xml), 'numCache')).toEqual([]);
        expect(throughRanges(rangeSpec('column'))).toEqual(rangeSpec('column'));
    });

    test('the same spec writes the same bytes', () => {
        const spec = rangeSpec('pie', {}, RANGE_SERIES.slice(0, 1));
        expect(writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME })).toBe(
            writeChart(parsed(spec), { ranges, look: FLAT_CHART_LOOK, frame: FRAME }),
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

    test("a pie keeps its values' format and its type's gridlines, losing only the axis titles it has no axes for", () => {
        const sample = sampleChartSpec('pie');
        const spec = { ...sample, axes: { ...sample.axes, y: { ...sample.axes.y, labels: { format: '0.0' } } } };
        const back = read(writeChart(spec, INLINE), 'cache');
        expect(back).toEqual(axesOf(spec));
        expect(back.axes.y).toMatchObject({ labels: { format: '0.0' }, gridlines: sample.axes.y.gridlines });
    });

    test("the text is the size Eigen draws it in the box, at the file's scale", () => {
        const spec = { ...sampleChartSpec('column'), title: { text: 'Sales' } };
        const at = (frame: typeof FRAME) => {
            const chart = root(writeChart(spec, { look: FLAT_CHART_LOOK, frame }));
            return [...find(chart, 'defRPr', A_NS), ...find(chart, 'rPr', A_NS)].map((run) => xmlAttr(run, '', 'sz'));
        };
        // 0.035 of the 371 px side is 12.985 px, 9.74 pt on a page; the title 1.3 times it.
        const label = Math.round(chartFontSize(600, 371) * 75);
        const title = Math.round(chartFontSize(600, 371) * CHART_TITLE_SCALE * 75);
        expect(new Set(at(FRAME))).toEqual(new Set([String(label), String(title)]));
        // A slide's px is half a page's: 1920 px across 720 pt.
        expect(at({ ...FRAME, emuPerPx: EMU_PER_PX / 2 })).toContain(String(Math.round(label / 2)));
    });

    test("a chart drawn tiny keeps its text at Office's smallest size, 1 pt", () => {
        const chart = root(
            writeChart(sampleChartSpec('column'), { look: FLAT_CHART_LOOK, frame: { ...FRAME, emuPerPx: 100 } }),
        );
        expect(new Set(find(chart, 'defRPr', A_NS).map((run) => xmlAttr(run, '', 'sz')))).toEqual(new Set(['100']));
    });
});

describe('writeChart with an embedded workbook', () => {
    const EMBEDDED = { ...INLINE, workbook: 'rId1' };
    const inline = (
        type: ChartType,
        categories: string[],
        series: InlineChartSeries[],
        format: string | null = null,
    ) => {
        const spec = parsed(defaultChartSpec(type, { source: 'inline', categories, series }));
        return { ...spec, axes: { ...spec.axes, y: { ...spec.axes.y, labels: { format } } } };
    };
    const MANY = Array.from({ length: 30 }, (_, i) => ({ id: `s-${i + 1}`, name: `Series ${i}`, values: [i, -i / 4] }));
    const SPECS: [string, ChartSpec][] = [
        [
            'names and categories that need escaping, a gap and a number as text',
            inline(
                'column',
                ['2025', 'North & <south>', '"quoted"'],
                [
                    { id: 's-1', name: "Bob's <sales> & co", values: [1.5, null, -6e-7] },
                    { id: 's-2', name: '', values: [4, 5, 6] },
                ],
                '#,##0.0',
            ),
        ],
        ['a single category', inline('line', ['Only'], [{ id: 's-1', name: 'One', values: [3] }])],
        [
            'an empty series beside a ragged one',
            inline(
                'line',
                ['a', 'b', 'c'],
                [
                    { id: 's-1', name: 'Empty', values: [] },
                    { id: 's-2', name: 'Short', values: [1, 2] },
                ],
            ),
        ],
        ['no categories', inline('column', [], [{ id: 's-1', name: 'Alone', values: [] }])],
        ['thirty series, past column Z', inline('bar', ['x', 'y'], MANY)],
        ['a pie in a format of its own', inline('pie', ['a', 'b'], [{ id: 's-1', name: 'Pie', values: [1, 3] }], '0%')],
    ];

    test.each(SPECS)('%s: every ref names cells of the sheet holding what its cache holds', (_, spec) => {
        const sheet = embeddedChartSheet(spec);
        if (!sheet) throw new Error('no sheet');
        const refs = refsAgainstCells(root(writeChart(spec, EMBEDDED)), sheet);
        expect(refs.length).toBeGreaterThan(0);
        for (const { formula, cache, cells } of refs) expect({ formula, cells }).toEqual({ formula, cells: cache });
    });

    test.each(SPECS)('%s: reads back from the caches as itself', (_, spec) => {
        expect(read(writeChart(spec, EMBEDDED), 'cache')).toEqual(axesOf(spec));
    });

    test("the refs name Office's layout: names along row 1 from B, categories down A, each series down its column", () => {
        const formulas = find(root(writeChart(SPECS[4][1], EMBEDDED)), 'f').map(xmlTrimmedText);
        expect(formulas.slice(0, 3)).toEqual(["'Sheet1'!$B$1", "'Sheet1'!$A$2:$A$3", "'Sheet1'!$B$2:$B$3"]);
        expect(formulas.slice(-3)).toEqual(["'Sheet1'!$AE$1", "'Sheet1'!$A$2:$A$3", "'Sheet1'!$AE$2:$AE$3"]);
    });

    test('the values keep their format in the cells, and the part names its workbook after its text, never to refresh', () => {
        const [, spec] = SPECS[0];
        const value = embeddedChartSheet(spec)?.celldata?.find(({ r, c }) => r === 1 && c === 1)?.v;
        expect(value).toEqual({ v: 1.5, ct: { fa: '#,##0.0', t: 'n' } });
        const chart = root(writeChart(spec, EMBEDDED));
        const tail = xmlElements(chart).slice(-2);
        expect(tail.map((element) => element.local)).toEqual(['txPr', 'externalData']);
        expect([xmlAttr(tail[1], R_NS, 'id'), val(tail[1], 'autoUpdate')]).toEqual(['rId1', '0']);
    });

    test('range data names its own cells and embeds no workbook', () => {
        const spec = rangeSpec('column');
        expect(embeddedChartSheet(spec)).toBeUndefined();
        const xml = writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME, workbook: 'rId1' });
        expect(xml).toBe(writeChart(spec, { ranges, look: FLAT_CHART_LOOK, frame: FRAME }));
    });
});

describe('readChartPartLook', () => {
    const LOOK: ChartLook = {
        ...FLAT_CHART_LOOK,
        fill: solidFill('#fafaf0'),
        color: '#112233',
        strokeColor: '#44556680',
        strokeWidth: 3,
    };
    const lookOf = (spec: ChartSpec, look: ChartLook, emuPerPx: number) =>
        readChartPartLook(root(writeChart(spec, { look, frame: { ...FRAME, emuPerPx } })), {
            theme,
            emuPerPx,
            host: 'xlsx',
        });

    test.each(['column', 'bar', 'line'] as const)(
        "a %s chart's background, label colour and stroke read back at any scale",
        (type) => {
            for (const emuPerPx of [EMU_PER_PX, 6350]) {
                expect(lookOf(sampleChartSpec(type), LOOK, emuPerPx)).toEqual({
                    fill: LOOK.fill,
                    color: LOOK.color,
                    strokeColor: LOOK.strokeColor,
                    strokeWidth: LOOK.strokeWidth,
                });
            }
        },
    );

    test('no background and no label colour read back as themselves; a pie has no stroke to read, so it reads flat', () => {
        const look = { ...LOOK, fill: FLAT_CHART_LOOK.fill, color: 'transparent' };
        expect(lookOf(sampleChartSpec('pie'), look, EMU_PER_PX)).toEqual({
            fill: FLAT_CHART_LOOK.fill,
            color: 'transparent',
            strokeColor: FLAT_CHART_LOOK.strokeColor,
            strokeWidth: FLAT_CHART_LOOK.strokeWidth,
        });
    });

    test('a gradient background is written as its middle colour', () => {
        const fill = serializeFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 0, style: 'solid' });
        const [, middle] = gradientStops('#000000', '#ffffff', 3);
        expect(lookOf(sampleChartSpec('column'), { ...LOOK, fill }, EMU_PER_PX).fill).toBe(solidFill(middle.color));
    });

    // Office's default theme: black text on white.
    const office: DrawingTheme = {
        scheme: new Map([
            ['dk1', '#000000'],
            ['lt1', '#ffffff'],
        ]),
        map: IDENTITY_COLOR_MAP,
    };
    // tx1 at a 75% tint, in linear light.
    const AUTOMATIC_LINE = '#8c8c8c';
    const part = (plot: string, shape = '') =>
        root(
            `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}"><c:chart><c:plotArea>${plot}</c:plotArea></c:chart>${shape}</c:chartSpace>`,
        );
    const AXES = '<c:barChart/><c:catAx/><c:valAx/>';
    const look = (chart: XmlElement, host: ChartHost = 'xlsx', emuPerPx = EMU_PER_PX) =>
        readChartPartLook(chart, { theme: office, emuPerPx, host });

    test("a label without a colour of its own takes the theme's tx1, as Office draws it, and a pie's stroke reads flat", () => {
        const dark: DrawingTheme = { scheme: new Map([['lt1', '#fefefe']]), map: new Map([['tx1', 'lt1']]) };
        const chart = root(`<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}"><c:chart/></c:chartSpace>`);
        const { fill, strokeColor, strokeWidth } = FLAT_CHART_LOOK;
        expect(readChartPartLook(chart, { theme: dark, emuPerPx: EMU_PER_PX, host: 'pptx' })).toEqual({
            fill,
            color: '#fefefe',
            strokeColor,
            strokeWidth,
        });
    });

    test("a part that states no background takes the theme's bg1 in a docx and an xlsx, and none on a slide", () => {
        for (const shape of ['', '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>']) {
            expect(look(part(AXES, shape), 'docx').fill).toBe(solidFill('#ffffff'));
            expect(look(part(AXES, shape), 'xlsx').fill).toBe(solidFill('#ffffff'));
            expect(look(part(AXES, shape), 'pptx').fill).toBe(FLAT_CHART_LOOK.fill);
        }
    });

    test("an axis without a line of its own draws Office's automatic one, 0.75 pt of tx1 at a 75% tint", () => {
        for (const axis of ['<c:catAx/>', '<c:catAx><c:spPr><a:noFill/></c:spPr></c:catAx>']) {
            const chart = part(`<c:barChart/>${axis}<c:valAx/>`);
            expect(look(chart)).toMatchObject({ strokeColor: AUTOMATIC_LINE, strokeWidth: 1 });
            expect(look(chart, 'pptx', 6350).strokeWidth).toBe(1.5);
        }
        const widthOnly = part('<c:barChart/><c:catAx><c:spPr><a:ln w="19050"/></c:spPr></c:catAx><c:valAx/>');
        expect(look(widthOnly)).toMatchObject({ strokeColor: AUTOMATIC_LINE, strokeWidth: 2 });
    });

    test('an axis drawn without a line keeps its gridlines, which the stroke draws then', () => {
        const hidden = '<c:catAx><c:spPr><a:ln><a:noFill/></a:ln></c:spPr></c:catAx>';
        const gridlines = (shape: string) =>
            part(`<c:barChart/>${hidden}<c:valAx><c:majorGridlines>${shape}</c:majorGridlines></c:valAx>`);
        const own = '<c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>';
        expect(look(gridlines(own))).toMatchObject({ strokeColor: '#d9d9d9', strokeWidth: 1.33 });
        expect(look(gridlines(''))).toMatchObject({ strokeColor: AUTOMATIC_LINE, strokeWidth: 1 });
        expect(look(part(`<c:barChart/>${hidden}<c:valAx/>`)).strokeColor).toBe(TRANSPARENT_COLOR);
    });

    test('a gradient background reads as its middle colour, its stops by position, and a pattern as its foreground', () => {
        const gradient =
            '<c:spPr><a:gradFill><a:gsLst><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="0"><a:srgbClr val="000000"/></a:gs></a:gsLst></a:gradFill></c:spPr>';
        const [, middle] = gradientStops('#000000', '#ffffff', 3);
        expect(look(part(AXES, gradient)).fill).toBe(solidFill(middle.color));
        const pattern =
            '<c:spPr><a:pattFill prst="pct5"><a:fgClr><a:srgbClr val="FF0000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill></c:spPr>';
        expect(look(part(AXES, pattern)).fill).toBe(solidFill('#ff0000'));
    });
});

describe('chartGraphicXml', () => {
    test('declares the chart prefixes on c:chart, so any host part can hold it', () => {
        const frame = root(`<a:graphicFrame xmlns:a="${A_NS}">${chartGraphicXml('rId7')}</a:graphicFrame>`);
        const [chart] = find(frame, 'chart');
        expect(chart && xmlAttr(chart, R_NS, 'id')).toBe('rId7');
    });
});
