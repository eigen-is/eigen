import { chartColor, chartPointColor, chartSeriesStyle, GRIDLINE_OPACITY } from '@workspace/lib/charts';
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
import { escapeXml } from '@workspace/lib/xml';
import { quoteSheetName, rangeToA1 } from '@workspace/sheet/engine/a1-notation';
import { DEGREE, solidFillXml } from './drawingml';
import { A_NS, C_NS, EMU_PER_PX, R_NS } from './ooxml';
import { LEGEND_BY_POSITION, PERCENT_AXIS_FORMAT, STACKING_BY_GROUPING } from './ooxml-chart';

// A ChartSpec as a DrawingML chart part, c:chartSpace, which the xlsx, docx and pptx exports write: the mirror of
// ooxml-chart.ts, which reads it back as the same spec. Office draws what Eigen draws: an automatic colour is written as
// the palette's at its place, which the reader reads back as automatic, and the look as Office's shape properties.

export type ChartWriteOptions = {
    // Range data's sheets by the names the workbook writes them under; a ref to a sheet it doesn't name is #REF!.
    ranges: (sheetId: string) => string | undefined;
    // What range data's cells show (resolveRangeChartData), its series those with values: the refs' caches, which
    // Excel shows until it recalculates. Without it the refs go alone.
    cache?: ChartData;
    look: ChartLook;
};

// The fixed c:axId of x, the category axis, and y, the value axis.
const CATEGORY_AXIS = 1;
const VALUE_AXIS = 2;

// The reader's spellings turned around, the first of each the one written: clustered, not standard; r, not tr.
const GROUPING = turned(STACKING_BY_GROUPING);
const LEGEND = turned(LEGEND_BY_POSITION);

// A frame's graphic showing the chart part its relationship names; the frame's part declares the c: prefix.
export function chartGraphicXml(rId: string): string {
    return `<a:graphic><a:graphicData uri="${C_NS}"><c:chart r:id="${rId}"/></a:graphicData></a:graphic>`;
}

export function writeChart(spec: ChartSpec, { ranges, cache, look }: ChartWriteOptions): string {
    const text = textProperties(look.color, spec.chart.fontFamily);
    const group = groupXml(spec, look, ranges, cache);
    const plot = spec.chart.type === 'pie' ? group : `${group}${axesXml(spec, look)}`;
    const { position } = spec.legend;
    const legend = position === 'none' ? '' : legendXml(position);
    const background = parseFill(look.fill);
    const fill = background.type === 'solid' ? solidFillXml(background.color) : '<a:noFill/>';
    return [
        `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">`,
        '<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart>',
        spec.title.text
            ? `${titleXml(spec.title.text, { bold: true })}<c:autoTitleDeleted val="0"/>`
            : '<c:autoTitleDeleted val="1"/>',
        `<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}`,
        // Eigen reads a hidden row's cells like any other.
        `<c:plotVisOnly val="0"/><c:dispBlanksAs val="${spec.chart.blanks}"/></c:chart>`,
        `<c:spPr>${fill}<a:ln><a:noFill/></a:ln></c:spPr>${text}</c:chartSpace>`,
    ].join('');
}

type Ranges = ChartWriteOptions['ranges'];

function groupXml(spec: ChartSpec, look: ChartLook, ranges: Ranges, cache: ChartData | undefined): string {
    const series = seriesXml(spec, look, ranges, cache);
    const axes = `<c:axId val="${CATEGORY_AXIS}"/><c:axId val="${VALUE_AXIS}"/>`;
    const { type } = spec.chart;
    if (type === 'pie') return `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
    if (type === 'line') {
        return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`;
    }
    const { stacking } = spec.plots[type];
    const stacked = stacking !== 'none';
    return [
        `<c:barChart><c:barDir val="${type === 'bar' ? 'bar' : 'col'}"/>`,
        `<c:grouping val="${GROUPING.get(stacking)}"/><c:varyColors val="0"/>${series}`,
        `<c:gapWidth val="150"/>${stacked ? '<c:overlap val="100"/>' : ''}${axes}</c:barChart>`,
    ].join('');
}

// Each series in the spec's order, its place its idx and order, so the reader's palette slot is the one written.
function seriesXml(spec: ChartSpec, look: ChartLook, ranges: Ranges, cache: ChartData | undefined): string {
    const { data } = spec;
    const sources =
        data.source === 'inline'
            ? data.series.map(({ name, values }) => inlineSource(data.categories, name, values))
            : rangeSources(data, ranges, cache);
    const { type } = spec.chart;
    const width = Math.round(look.strokeWidth * EMU_PER_PX);
    return data.series
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

// A series' name, categories and values, and how many points it plots: a range series its cache's, none without one.
type Source = { name: string; data: string; points: number };

function inlineSource(categories: string[], name: string, values: (number | null)[]): Source {
    return {
        name: `<c:tx><c:v>${escapeXml(name)}</c:v></c:tx>`,
        data: `<c:cat><c:strLit>${pointsXml(categories)}</c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode>${pointsXml(values)}</c:numLit></c:val>`,
        points: Math.max(categories.length, values.length),
    };
}

// A series without values has no place in the cache.
function rangeSources(data: RangeChartData, ranges: Ranges, cache: ChartData | undefined): Source[] {
    let resolved = 0;
    return data.series.map((series) =>
        rangeSource(data.categories, series, ranges, {
            categories: cache?.categories,
            series: series.values ? cache?.series[resolved++] : undefined,
        }),
    );
}

function rangeSource(
    categories: CellRangeRef | null,
    { name, values }: RangeChartSeries,
    ranges: Ranges,
    cache: { categories: string[] | undefined; series: InlineChartSeries | undefined },
): Source {
    const strCache = (points: string[] | undefined) => (points ? `<c:strCache>${pointsXml(points)}</c:strCache>` : '');
    const numCache = cache.series
        ? `<c:numCache><c:formatCode>General</c:formatCode>${pointsXml(cache.series.values)}</c:numCache>`
        : '';
    const formula = (ref: CellRangeRef) => `<c:f>${escapeXml(cellRange(ref, ranges))}</c:f>`;
    const named = cache.series && [cache.series.name];
    return {
        name:
            typeof name === 'string'
                ? `<c:tx><c:v>${escapeXml(name)}</c:v></c:tx>`
                : `<c:tx><c:strRef>${formula(name)}${strCache(named)}</c:strRef></c:tx>`,
        data: [
            categories ? `<c:cat><c:strRef>${formula(categories)}${strCache(cache.categories)}</c:strRef></c:cat>` : '',
            values ? `<c:val><c:numRef>${formula(values)}${numCache}</c:numRef></c:val>` : '',
        ].join(''),
        points: cache.series?.values.length ?? 0,
    };
}

// A cache's or literal's points, a gap none.
function pointsXml(points: readonly (string | number | null)[]): string {
    const written = points.map((point, i) =>
        point === null ? '' : `<c:pt idx="${i}"><c:v>${escapeXml(String(point))}</c:v></c:pt>`,
    );
    return `<c:ptCount val="${points.length}"/>${written.join('')}`;
}

// 'Sheet'!$A$2:$A$9 by the name the workbook writes.
function cellRange(ref: CellRangeRef, ranges: Ranges): string {
    const name = ranges(ref.sheetId);
    return name === undefined ? '#REF!' : `${quoteSheetName(name)}!${rangeToA1(ref, true)}`;
}

// x, the category axis, then y, the value axis. A bar chart lies on its side. CHARTS.md: the category axis is maxMin
// when (type === 'bar') !== reversed, and the value axis crosses it at that end, so it stays where Eigen draws it.
function axesXml(spec: ChartSpec, look: ChartLook): string {
    const { x: categoryAxis, y: valueAxis } = spec.axes;
    const { type } = spec.chart;
    const sideways = type === 'bar';
    const maxMin = sideways !== categoryAxis.scale.reversed;
    const stroke = (opacity = 1) =>
        `<a:ln w="${Math.round(look.strokeWidth * EMU_PER_PX)}">${solidFillXml(look.strokeColor, opacity)}</a:ln>`;
    const deleted = (visible: boolean) => `<c:delete val="${visible ? 0 : 1}"/>`;
    const noTicks = '<c:majorTickMark val="none"/><c:minorTickMark val="none"/>';
    const scaling = (orientation: string, bounds = '') =>
        `<c:scaling><c:orientation val="${orientation}"/>${bounds}</c:scaling>`;
    const { min, max } = valueAxis.scale;
    const bounds = [max === null ? '' : `<c:max val="${max}"/>`, min === null ? '' : `<c:min val="${min}"/>`].join('');
    // A 100% stack's axis runs 0 to 1; without a format of its own Excel would label it so.
    const own = valueAxis.labels.format;
    const format = own ?? (spec.plots[type].stacking === 'percent' ? PERCENT_AXIS_FORMAT : 'General');
    const linked = own === null && format === 'General';
    return [
        `<c:catAx><c:axId val="${CATEGORY_AXIS}"/>${scaling(maxMin ? 'maxMin' : 'minMax')}${deleted(categoryAxis.visible)}`,
        `<c:axPos val="${sideways ? 'l' : 'b'}"/>${axisTitleXml(categoryAxis.title.text, sideways)}`,
        `<c:numFmt formatCode="General" sourceLinked="1"/>${noTicks}<c:tickLblPos val="low"/><c:spPr>${stroke()}</c:spPr>`,
        `<c:crossAx val="${VALUE_AXIS}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`,
        `<c:valAx><c:axId val="${VALUE_AXIS}"/>${scaling('minMax', bounds)}${deleted(valueAxis.visible)}`,
        `<c:axPos val="${sideways ? 'b' : 'l'}"/>`,
        valueAxis.gridlines.visible
            ? `<c:majorGridlines><c:spPr>${stroke(GRIDLINE_OPACITY / 100)}</c:spPr></c:majorGridlines>`
            : '',
        axisTitleXml(valueAxis.title.text, !sideways),
        `<c:numFmt formatCode="${escapeXml(format)}" sourceLinked="${linked ? 1 : 0}"/>${noTicks}`,
        `<c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:crossAx val="${CATEGORY_AXIS}"/>`,
        `<c:crosses val="${maxMin ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`,
    ].join('');
}

function axisTitleXml(title: string, upright: boolean): string {
    return title ? titleXml(title, { bold: false, turned: upright }) : '';
}

// A vertical axis's title turns a quarter, reading upward.
function titleXml(title: string, { bold, turned = false }: { bold: boolean; turned?: boolean }): string {
    const weight = bold ? 1 : 0;
    return [
        `<c:title><c:tx><c:rich><a:bodyPr${turned ? ` rot="${-90 * DEGREE}" vert="horz"` : ''}/><a:lstStyle/>`,
        `<a:p><a:pPr><a:defRPr b="${weight}"/></a:pPr><a:r><a:rPr lang="en-US" b="${weight}"/><a:t>${escapeXml(title)}</a:t></a:r></a:p>`,
        '</c:rich></c:tx><c:overlay val="0"/></c:title>',
    ].join('');
}

function legendXml(position: Exclude<LegendPosition, 'none'>): string {
    return `<c:legend><c:legendPos val="${LEGEND.get(position)}"/><c:overlay val="0"/></c:legend>`;
}

// Every label's colour and the spec's font.
function textProperties(color: string, font: string): string {
    return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr>${solidFillXml(color)}<a:latin typeface="${escapeXml(font)}"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
}

function turned<K, V>(read: ReadonlyMap<K, V>): Map<V, K> {
    return new Map([...read].reverse().map(([key, value]) => [value, key]));
}
