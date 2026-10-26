// Writes a ChartSpec as a DrawingML chart part, the c:chartSpace that xlsx, docx and pptx files share, for the Office
// exports. It is the mirror of readChart and readChartPartLook, which read the part back as the same spec and look.
// Office draws what Eigen draws: an automatic colour is written as the palette's colour at its place, and the look as
// the part's shape and text properties, at the sizes Eigen gives the chart's box. A docx's or pptx's inline numbers go
// as refs into a workbook embedded beside the part, laid out as desktop Office lays one out, for its Edit Data.

import { gradientStops } from '@workspace/lib/background';
import {
    BAR_GROUP_WIDTH,
    CHART_TITLE_SCALE,
    chartColor,
    chartFontSize,
    chartPaintOf,
    chartPointColor,
    chartSeriesStyle,
    GRIDLINE_OPACITY,
} from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import type {
    CellRangeRef,
    ChartData,
    ChartLook,
    ChartSpec,
    InlineChartSeries,
    LegendPosition,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import { parseFill } from '@workspace/lib/vector';
import { escapeXml, stripNonXmlChars } from '@workspace/lib/xml';
import { rangeToA1, sheetRefName } from '@workspace/sheet/engine/a1-notation';
import { clampTextSize, DEGREE, solidFillXml } from './drawingml';
import { A_NS, C_NS, EMU_PER_POINT, R_NS } from './ooxml';
import { LEGEND_BY_POSITION, PERCENT_AXIS_FORMAT, STACKING_BY_GROUPING } from './ooxml-chart';

// The chart's own box in px, which Eigen lays it out in, and how many EMU one of those px is in the file. Text sizes
// and line widths scale by it, so a chart drawn smaller or larger than its box keeps Eigen's proportions.
type ChartFrame = { width: number; height: number; emuPerPx: number };

export type ChartWriteOptions = {
    // The name the workbook writes a range's sheet under. A ref to a sheet it doesn't name is written as #REF!. Inline
    // data names no sheet.
    ranges?: (sheetId: string) => string | undefined;
    // What range data's cells show (resolveRangeChartData), with a series for each that has values. It becomes the
    // refs' caches, which Excel shows until it recalculates. Without it the refs are written without caches.
    cache?: ChartData;
    look: ChartLook;
    frame: ChartFrame;
    // For a docx or a pptx: the r:id of the part's relationship to the workbook that holds its inline data. The refs
    // name that workbook's cells, each with its cache. Without it inline data is written as literals.
    workbook?: string;
};

type Ranges = NonNullable<ChartWriteOptions['ranges']>;

// The fixed c:axId of x, the category axis, and of y, the value axis.
const CATEGORY_AXIS = 1;
const VALUE_AXIS = 2;

// ST_GapAmount's largest gap, in percent of a bar's width.
const MAX_GAP_WIDTH = 500;

// The reader's tables turned around. Where two spellings read the same, the reader's first is the one written:
// clustered rather than standard, r rather than tr.
const GROUPING = turned(STACKING_BY_GROUPING);
const LEGEND = turned(LEGEND_BY_POSITION);

// A frame's graphic, showing the chart part its relationship names. c:chart declares its own prefixes, as Office
// writes it, so no host part has to.
export function chartGraphicXml(rId: string): string {
    return `<a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${rId}"/></a:graphicData></a:graphic>`;
}

// Whether the part draws the look plainer than Eigen does. writeChart paints a sketch, a hatch and a dashed or dotted
// stroke plain, and a gradient background as one colour. A host whose frame turns or fades the chart passes that as
// `layer`, since no chart part carries either.
export function chartLookSimplified(look: ChartLook, layer?: { angle: number; opacity: number }): boolean {
    const paint = chartPaintOf(look);
    return (
        paint.roughness > 0 ||
        paint.strokeStyle !== 'solid' ||
        paint.fillStyle !== 'solid' ||
        parseFill(paint.background).type === 'gradient' ||
        (layer !== undefined && (layer.angle !== 0 || layer.opacity !== 100))
    );
}

export function writeChart(
    spec: ChartSpec,
    { ranges = () => undefined, cache, look, frame, workbook }: ChartWriteOptions,
): string {
    const sizes = textSizes(frame);
    const width = Math.round(look.strokeWidth * frame.emuPerPx);
    const text = textProperties(look.color, spec.chart.fontFamily, sizes.text);
    const embedded = workbook !== undefined && spec.data.source === 'inline';
    const series = Math.round(chartPaintOf(look).seriesStrokeWidth * frame.emuPerPx);
    const group = groupXml(spec, series, sourcesOf(spec, ranges, cache, embedded));
    const plot = spec.chart.type === 'pie' ? group : `${group}${axesXml(spec, look, width, sizes.text)}`;
    const { position } = spec.legend;
    const legend = position === 'none' ? '' : legendXml(position);
    const background = parseFill(look.fill);
    // The writer gives a chart part's background one colour, so a gradient is written as its middle colour.
    const { color, opacity } =
        background.type === 'solid'
            ? { color: background.color, opacity: 1 }
            : gradientStops(background.from, background.to, 3)[1];
    return [
        `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">`,
        '<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>',
        spec.title.text
            ? `${titleXml(spec.title.text, { bold: true, size: sizes.title })}<c:autoTitleDeleted val="0"/>`
            : '<c:autoTitleDeleted val="1"/>',
        `<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}`,
        // Eigen plots a hidden row's cells like any other, so Office should too.
        `<c:plotVisOnly val="0"/><c:dispBlanksAs val="${spec.chart.blanks}"/></c:chart>`,
        `<c:spPr>${solidFillXml(color, opacity)}<a:ln><a:noFill/></a:ln></c:spPr>${text}`,
        // The workbook is the part's own, not a linked file, so Office has nothing to refresh the caches from.
        embedded ? `<c:externalData r:id="${workbook}"><c:autoUpdate val="0"/></c:externalData>` : '',
        '</c:chartSpace>',
    ].join('');
}

// Office's text sizes: Eigen's label and title sizes for the box, at the file's scale.
function textSizes({ width, height, emuPerPx }: ChartFrame): { text: number; title: number } {
    const points = (chartFontSize(width, height) * emuPerPx) / EMU_PER_POINT;
    return { text: clampTextSize(points * 100), title: clampTextSize(points * CHART_TITLE_SCALE * 100) };
}

// Every label's colour and size, and the spec's font.
function textProperties(color: string, font: string, size: number): string {
    return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}">${solidFillXml(color)}<a:latin typeface="${escapeXml(font)}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
}

// ── Data ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Source = { name: string; data: string; points: number };

function sourcesOf(spec: ChartSpec, ranges: Ranges, cache: ChartData | undefined, embedded: boolean): Source[] {
    const { data } = spec;
    // A pie has no value axis to carry the values' format, so the values carry it, which is where Excel reads a pie's.
    const format = escapeXml(spec.axes.y.labels.format ?? 'General');
    if (data.source === 'range') return rangeSources(data, ranges, cache, format);
    return data.series.map((series, i) =>
        embedded ? embeddedSource(data.categories, series, i, format) : inlineSource(data.categories, series, format),
    );
}

function inlineSource(categories: string[], { name, values }: InlineChartSeries, format: string): Source {
    return {
        name: `<c:tx><c:v>${escapeXml(name)}</c:v></c:tx>`,
        data: `<c:cat>${strLit(categories)}</c:cat><c:val>${numLit(values, format)}</c:val>`,
        points: Math.max(categories.length, values.length),
    };
}

// The layout of a chart's own workbook, as Office lays it out. The refs name its cells, and embeddedChartSheet fills
// them from the same data: the series names along row 1 from B, the categories down column A from row 2, and each
// series' values down its own column. A1 stays empty.
const EMBEDDED_SHEET = 'Sheet1';

function seriesColumn(index: number): number {
    return index + 1;
}

// A range holds a cell at least, so no categories or no values are written as an empty literal.
function embeddedSource(
    categories: string[],
    { name, values }: InlineChartSeries,
    index: number,
    format: string,
): Source {
    const column = seriesColumn(index);
    const cells = (row: [number, number], at: number) =>
        `${sheetRefName(EMBEDDED_SHEET)}!${rangeToA1({ row, column: [at, at] }, true)}`;
    return {
        name: `<c:tx>${strRef(cells([0, 0], column), [name])}</c:tx>`,
        data: [
            `<c:cat>${categories.length > 0 ? strRef(cells([1, categories.length], 0), categories) : strLit([])}</c:cat>`,
            `<c:val>${values.length > 0 ? numRef(cells([1, values.length], column), values, format) : numLit([], format)}</c:val>`,
        ].join(''),
        points: Math.max(categories.length, values.length),
    };
}

// The sheet a docx's or pptx's chart embeds as its workbook, laid out as embeddedSource's refs name it. Each value is
// in the format its cache carries, and a gap is no cell. A label drops the characters XML can't hold, as its cache
// does, so the two can't disagree. Range data names a workbook's own cells, so it embeds none.
export function embeddedChartSheet(spec: ChartSpec): Sheet | undefined {
    if (spec.data.source !== 'inline') return undefined;
    const { categories, series } = spec.data;
    const format = spec.axes.y.labels.format;
    const number = format === null || format === 'General' ? {} : { ct: { fa: format, t: 'n' } };
    return {
        name: EMBEDDED_SHEET,
        celldata: [
            ...series.map(({ name }, i) => ({ r: 0, c: seriesColumn(i), v: { v: stripNonXmlChars(name) } })),
            ...categories.map((category, r) => ({ r: r + 1, c: 0, v: { v: stripNonXmlChars(category) } })),
            ...series.flatMap(({ values }, i) =>
                values.flatMap((value, r) =>
                    value === null ? [] : [{ r: r + 1, c: seriesColumn(i), v: { v: value, ...number } }],
                ),
            ),
        ],
    };
}

// A series without values has no place in the cache.
function rangeSources(data: RangeChartData, ranges: Ranges, cache: ChartData | undefined, format: string): Source[] {
    let resolved = 0;
    return data.series.map((series) =>
        rangeSource(data.categories, series, ranges, format, {
            categories: cache?.categories,
            series: series.values ? cache?.series[resolved++] : undefined,
        }),
    );
}

function rangeSource(
    categories: CellRangeRef | null,
    { name, values }: RangeChartSeries,
    ranges: Ranges,
    format: string,
    cache: { categories: string[] | undefined; series: InlineChartSeries | undefined },
): Source {
    const formula = (ref: CellRangeRef) => cellRange(ref, ranges);
    return {
        name:
            typeof name === 'string'
                ? `<c:tx><c:v>${escapeXml(name)}</c:v></c:tx>`
                : `<c:tx>${strRef(formula(name), cache.series && [cache.series.name])}</c:tx>`,
        data: [
            categories ? `<c:cat>${strRef(formula(categories), cache.categories)}</c:cat>` : '',
            values ? `<c:val>${numRef(formula(values), cache.series?.values, format)}</c:val>` : '',
        ].join(''),
        points: cache.series?.values.length ?? 0,
    };
}

// A ref with its cache, when there is one, and a literal with its points. Values are written in their format.
function strRef(formula: string, points: readonly string[] | undefined): string {
    const cache = points ? `<c:strCache>${pointsXml(points)}</c:strCache>` : '';
    return `<c:strRef><c:f>${escapeXml(formula)}</c:f>${cache}</c:strRef>`;
}

function numRef(formula: string, points: readonly (number | null)[] | undefined, format: string): string {
    const cache = points ? `<c:numCache><c:formatCode>${format}</c:formatCode>${pointsXml(points)}</c:numCache>` : '';
    return `<c:numRef><c:f>${escapeXml(formula)}</c:f>${cache}</c:numRef>`;
}

function strLit(points: readonly string[]): string {
    return `<c:strLit>${pointsXml(points)}</c:strLit>`;
}

function numLit(points: readonly (number | null)[], format: string): string {
    return `<c:numLit><c:formatCode>${format}</c:formatCode>${pointsXml(points)}</c:numLit>`;
}

// A cache's or a literal's points. A gap is no c:pt.
function pointsXml(points: readonly (string | number | null)[]): string {
    const written = points.map((point, i) =>
        point === null ? '' : `<c:pt idx="${i}"><c:v>${escapeXml(String(point))}</c:v></c:pt>`,
    );
    return `<c:ptCount val="${points.length}"/>${written.join('')}`;
}

// A ref such as Sheet!$A$2:$A$9, by the name the workbook writes the sheet under.
function cellRange(ref: CellRangeRef, ranges: Ranges): string {
    const name = ranges(ref.sheetId);
    return name === undefined ? '#REF!' : `${sheetRefName(name)}!${rangeToA1(ref, true)}`;
}

// ── Groups, axes and titles ─────────────────────────────────────────────────────────────────────────────────────

// `width` is a line series' width in EMU.
function groupXml(spec: ChartSpec, width: number, sources: Source[]): string {
    const series = seriesXml(spec, width, sources);
    const axes = `<c:axId val="${CATEGORY_AXIS}"/><c:axId val="${VALUE_AXIS}"/>`;
    const { type } = spec.chart;
    if (type === 'pie') return `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
    if (type === 'line') {
        return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`;
    }
    const { stacking } = spec.plots[type];
    const stacked = stacking !== 'none';
    // Office's gap between categories is a share of one bar's width, so the bars side by side and the gap make up the
    // category. This gap leaves the bars the share Eigen draws them at, up to the widest gap ST_GapAmount allows.
    const bars = stacked ? 1 : spec.data.series.length;
    const gap = Math.min(MAX_GAP_WIDTH, Math.round((100 * bars * (1 - BAR_GROUP_WIDTH)) / BAR_GROUP_WIDTH));
    return [
        `<c:barChart><c:barDir val="${type === 'bar' ? 'bar' : 'col'}"/>`,
        `<c:grouping val="${GROUPING.get(stacking)}"/><c:varyColors val="0"/>${series}`,
        `<c:gapWidth val="${gap}"/>${stacked ? '<c:overlap val="100"/>' : ''}${axes}</c:barChart>`,
    ].join('');
}

// Each series in the spec's order, its place written as its idx and order, so the reader picks the same palette slot.
function seriesXml(spec: ChartSpec, width: number, sources: Source[]): string {
    const { type } = spec.chart;
    return spec.data.series
        .map(({ id }, i) => {
            const style = chartSeriesStyle(spec, id);
            const color = style.color ?? chartColor(i);
            const source = sources[i];
            const head = `<c:idx val="${i}"/><c:order val="${i}"/>${source.name}`;
            if (type === 'line') {
                const marker = style.marker.visible
                    ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${solidFillXml(color)}<a:ln>${solidFillXml(color)}</a:ln></c:spPr></c:marker>`
                    : '<c:marker><c:symbol val="none"/></c:marker>';
                const line = `<c:spPr><a:ln w="${width}" cap="rnd">${solidFillXml(color)}<a:round/></a:ln></c:spPr>`;
                return `<c:ser>${head}${line}${marker}${source.data}<c:smooth val="${style.line.smooth ? 1 : 0}"/></c:ser>`;
            }
            if (type === 'pie') {
                const points = i === 0 ? slicesXml(spec, id, source.points) : '';
                return `<c:ser>${head}<c:spPr>${solidFillXml(color)}</c:spPr>${points}${PIE_LABELS}${source.data}</c:ser>`;
            }
            return `<c:ser>${head}<c:spPr>${solidFillXml(color)}</c:spPr><c:invertIfNegative val="0"/>${source.data}</c:ser>`;
        })
        .join('');
}

// Eigen labels a slice with its name and share, beside it.
const PIE_LABELS =
    '<c:dLbls><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>';

// A pie's slices are its first series' points, each written as a c:dPt.
function slicesXml(spec: ChartSpec, id: string, points: number): string {
    return Array.from({ length: points }, (_, i) => {
        const color = chartPointColor(spec, id, i) ?? chartColor(i);
        return `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${solidFillXml(color)}</c:spPr></c:dPt>`;
    }).join('');
}

// x, the category axis, then y, the value axis. A bar chart lies on its side. The category axis runs maxMin when
// (type === 'bar') !== reversed, and then the value axis crosses it at that end, so the value axis stays where Eigen
// draws it.
function axesXml(spec: ChartSpec, look: ChartLook, width: number, size: number): string {
    const { x: categoryAxis, y: valueAxis } = spec.axes;
    const { type } = spec.chart;
    const sideways = type === 'bar';
    const maxMin = sideways !== categoryAxis.scale.reversed;
    const stroke = (opacity = 1) => `<a:ln w="${width}">${solidFillXml(look.strokeColor, opacity)}</a:ln>`;
    const deleted = (visible: boolean) => `<c:delete val="${visible ? 0 : 1}"/>`;
    const noTicks = '<c:majorTickMark val="none"/><c:minorTickMark val="none"/>';
    const scaling = (orientation: string, bounds = '') =>
        `<c:scaling><c:orientation val="${orientation}"/>${bounds}</c:scaling>`;
    const { min, max } = valueAxis.scale;
    const bounds = [max === null ? '' : `<c:max val="${max}"/>`, min === null ? '' : `<c:min val="${min}"/>`].join('');
    // A 100% stack's axis runs from 0 to 1. Without a format of its own, Excel would label it that way.
    const own = valueAxis.labels.format;
    const format = own ?? (spec.plots[type].stacking === 'percent' ? PERCENT_AXIS_FORMAT : 'General');
    const linked = own === null && format === 'General';
    return [
        `<c:catAx><c:axId val="${CATEGORY_AXIS}"/>${scaling(maxMin ? 'maxMin' : 'minMax')}${deleted(categoryAxis.visible)}`,
        `<c:axPos val="${sideways ? 'l' : 'b'}"/>${axisTitleXml(categoryAxis.title.text, sideways, size)}`,
        `<c:numFmt formatCode="General" sourceLinked="1"/>${noTicks}<c:tickLblPos val="low"/><c:spPr>${stroke()}</c:spPr>`,
        `<c:crossAx val="${VALUE_AXIS}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`,
        `<c:valAx><c:axId val="${VALUE_AXIS}"/>${scaling('minMax', bounds)}${deleted(valueAxis.visible)}`,
        `<c:axPos val="${sideways ? 'b' : 'l'}"/>`,
        valueAxis.gridlines.visible
            ? `<c:majorGridlines><c:spPr>${stroke(GRIDLINE_OPACITY / 100)}</c:spPr></c:majorGridlines>`
            : '',
        axisTitleXml(valueAxis.title.text, !sideways, size),
        `<c:numFmt formatCode="${escapeXml(format)}" sourceLinked="${linked ? 1 : 0}"/>${noTicks}`,
        `<c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:crossAx val="${CATEGORY_AXIS}"/>`,
        `<c:crosses val="${maxMin ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`,
    ].join('');
}

// An axis title is drawn at the labels' size, as Eigen draws it.
function axisTitleXml(title: string, upright: boolean, size: number): string {
    return title ? titleXml(title, { bold: false, size, turned: upright }) : '';
}

// A vertical axis's title turns a quarter, so it reads upward.
function titleXml(
    title: string,
    { bold, size, turned = false }: { bold: boolean; size: number; turned?: boolean },
): string {
    const run = `sz="${size}" b="${bold ? 1 : 0}"`;
    return [
        `<c:title><c:tx><c:rich><a:bodyPr${turned ? ` rot="${-90 * DEGREE}" vert="horz"` : ''}/><a:lstStyle/>`,
        `<a:p><a:pPr><a:defRPr ${run}/></a:pPr><a:r><a:rPr lang="en-US" ${run}/><a:t>${escapeXml(title)}</a:t></a:r></a:p>`,
        '</c:rich></c:tx><c:overlay val="0"/></c:title>',
    ].join('');
}

function legendXml(position: Exclude<LegendPosition, 'none'>): string {
    return `<c:legend><c:legendPos val="${LEGEND.get(position)}"/><c:overlay val="0"/></c:legend>`;
}

function turned<K, V>(read: ReadonlyMap<K, V>): Map<V, K> {
    return new Map([...read].reverse().map(([key, value]) => [value, key]));
}
