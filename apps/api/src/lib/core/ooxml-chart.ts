import {
    chartColor,
    chartLabel,
    DEFAULT_CHART_FONT,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    parseChartSpec,
} from '@workspace/lib/charts';
import { bundledFont } from '@workspace/lib/constants/fonts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import {
    type CellRangeRef,
    CHART_BLANKS,
    type ChartSeriesStyle,
    type ChartSpec,
    type ChartStacking,
    type ChartType,
    type LegendPosition,
} from '@workspace/lib/types/chart';
// The two engine modules a chart reads, not the engine: a docx or pptx import never evaluates the formula engine.
import { parseA1Range, unquoteSheetName } from '@workspace/sheet/engine/a1-notation';
import { numberDisplay } from '@workspace/sheet/engine/format';
import { type DrawingTheme, drawingColor, drawingLines, readColorMap } from './drawingml';
import { A_NS, alternativeFor, C_NS, isAlternateContent, isOn } from './ooxml';
import { type OoxmlPackage, optional, type Relationship, relTarget } from './opc';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText, xmlTrimmedText } from './xml';

// A DrawingML chart part, c:chartSpace, the same in a docx, an xlsx and a pptx, read into a ChartSpec. A chart the spec
// can't draw as the file does is no spec, with its title for the caller to show instead: never a different chart.

// docx and pptx draw from the caches, which hold every value; an xlsx's refs name its own sheets, by the importer's ids.
export type ChartSource = 'cache' | { ranges: (sheetName: string) => string | undefined };

// name is PowerPoint's for the chart's type, as Insert Chart lists it (Clustered Column, Pie of Pie, Combo), or none.
export type ChartRead = { spec: ChartSpec } | { unsupported: { title: string; name: string } };

export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

// The c:chartSpace an r:id names: only through a chart relationship, under the format's charts folder (ppt/charts/,
// word/charts/, xl/charts/) and of the chart content type, never its own relationships. A missing or damaged part is
// none, and costs only its chart.
export function chartPart(
    pkg: Pick<OoxmlPackage, 'part' | 'contentTypeOf'>,
    rels: ReadonlyMap<string, Relationship>,
    id: string | undefined,
    folder: string,
): XmlElement | undefined {
    const path = relTarget(rels, id, 'chart');
    if (!path?.startsWith(folder) || pkg.contentTypeOf(path) !== CHART_CONTENT_TYPE) return undefined;
    return optional(() => pkg.part(path));
}

// A part's elements and the points readChart builds from them: what a format charges before it reads a chart. A cache
// sizes its points by its c:ptCount, else by its last c:pt, whatever it holds, and the reader builds each series, the
// categories and the slices up to the longest before the spec's cap on all points together refuses them.
export function chartCost(root: XmlElement): number {
    let nodes = 0;
    let series = 0;
    let longest = 0;
    const open = [root];
    for (let element = open.pop(); element; element = open.pop()) {
        nodes++;
        if (element.ns === C_NS && element.local === 'ser') series++;
        const points =
            element.ns !== C_NS
                ? 0
                : element.local === 'ptCount'
                  ? Number(xmlAttr(element, '', 'val'))
                  : element.local === 'pt'
                    ? Number(xmlAttr(element, '', 'idx')) + 1
                    : 0;
        if (points > longest) longest = Math.min(points, MAX_CHART_POINTS);
        for (const found of xmlElements(element)) open.push(found);
    }
    return nodes + (Math.min(series, MAX_CHART_SERIES) + 2) * longest;
}

export const CHART_NOT_IMPORTED = 'Chart not imported';

// What a format shows for a chart readChart can't draw: which kind it was, and its title.
export function droppedChart({ title, name }: { title: string; name: string }): string[] {
    const label = name ? `${name} chart not imported` : CHART_NOT_IMPORTED;
    return title ? [label, title] : [label];
}

const TYPES = new Map<string, ChartType>([
    ['barChart', 'column'],
    ['bar3DChart', 'column'],
    ['lineChart', 'line'],
    ['line3DChart', 'line'],
    ['pieChart', 'pie'],
    ['pie3DChart', 'pie'],
]);

export const STACKING_BY_GROUPING: ReadonlyMap<string, ChartStacking> = new Map<string, ChartStacking>([
    ['clustered', 'none'],
    ['standard', 'none'],
    ['stacked', 'stacked'],
    ['percentStacked', 'percent'],
]);

// The format the writer gives a percent-stacked value axis that has none of its own; it reads back as none.
export const PERCENT_AXIS_FORMAT = '0%';

export const LEGEND_BY_POSITION: ReadonlyMap<string, LegendPosition> = new Map<string, LegendPosition>([
    ['t', 'top'],
    ['b', 'bottom'],
    ['l', 'left'],
    ['r', 'right'],
    ['tr', 'right'],
]);

// Requires names prefixes, not namespaces: the chart vocabulary this reader reads; c14's style and the like fall back.
const alternative = alternativeFor(new Set(['c', 'a', 'r']));

const UNSUPPORTED = new Error('unsupported chart');

function unsupported(): never {
    throw UNSUPPORTED;
}

export function readChart(root: XmlElement, { theme, data }: { theme: DrawingTheme; data: ChartSource }): ChartRead {
    const chart = hasXmlName(root, C_NS, 'chartSpace') ? child(root, 'chart') : undefined;
    const plotArea = child(chart, 'plotArea');
    const groups = elements(plotArea).filter((element) => element.ns === C_NS && element.local.endsWith('Chart'));
    const title = chartTitle(chart, groups);
    const colors = chartColors(root, theme);
    try {
        const [group] = groups;
        if (!group || groups.length > 1) unsupported();
        const spec = parseChartSpec(
            JSON.stringify({ ...chartSpec(chart, plotArea, group, colors, data), title, fontFamily: chartFont(root) }),
        );
        if (spec) return { spec };
    } catch (error) {
        if (error !== UNSUPPORTED) throw error;
    }
    return { unsupported: { title, name: chartName(groups) } };
}

// The host's colours through the part's own c:clrMapOvr, which replaces the host's map.
export function chartColors(root: XmlElement, theme: DrawingTheme): DrawingTheme {
    const override = child(root, 'clrMapOvr');
    return override ? { scheme: theme.scheme, map: readColorMap(override) } : theme;
}

function chartSpec(
    chart: XmlElement | undefined,
    plotArea: XmlElement | undefined,
    group: XmlElement,
    colors: DrawingTheme,
    data: ChartSource,
): Omit<ChartSpec, 'title' | 'fontFamily'> {
    const kind = TYPES.get(group.local) ?? unsupported();
    const type = kind === 'column' && val(child(group, 'barDir')) === 'bar' ? 'bar' : kind;
    const grouping = val(child(group, 'grouping')) ?? (type === 'line' ? 'standard' : 'clustered');
    // A pie has no grouping; the spec draws no stacked line.
    const stacking = type === 'line' && grouping !== 'standard' ? undefined : STACKING_BY_GROUPING.get(grouping);
    if (!stacking) unsupported();
    const valueAxes = children(plotArea, 'valAx');
    const categoryAxes = [...children(plotArea, 'catAx'), ...children(plotArea, 'dateAx')];
    const [valueAxis] = valueAxes;
    const [categoryAxis] = categoryAxes;
    const scaling = child(valueAxis, 'scaling');
    const orientation = (axis: XmlElement | undefined) => val(child(child(axis, 'scaling'), 'orientation'));
    if (valueAxes.length > 1 || categoryAxes.length > 1 || child(scaling, 'logBase')) unsupported();
    if (orientation(valueAxis) === 'maxMin') unsupported();
    // Excel's minMax category axis runs from the origin, so up a bar chart's side, where Google's runs down it. The
    // spec turns the whole axis rather than the data, since Excel's turns each category's series with it.
    const reversed = (type === 'bar') !== (orientation(categoryAxis) === 'maxMin');
    // A deleted axis, or one whose tick labels are none, shows no labels.
    const visible = (axis: XmlElement | undefined) =>
        flag(child(axis, 'delete')) !== true && val(child(axis, 'tickLblPos')) !== 'none';

    const all = children(group, 'ser');
    if (all.length > MAX_CHART_SERIES) unsupported();
    const ordered = all
        .map((ser, i) => ({ ser, order: count(val(child(ser, 'order'))) ?? i }))
        .sort((a, b) => a.order - b.order)
        .map(({ ser }) => ser);
    const series = type === 'pie' ? ordered.slice(0, 1) : ordered;
    const accent = (index: number) => {
        const slot = index < 6 ? colors.map.get(`accent${index + 1}`) : undefined;
        return (slot && colors.scheme.get(slot)) ?? chartColor(index);
    };
    const fillColor = (shape: XmlElement | undefined) =>
        drawingColor(shape && xmlChild(shape, A_NS, 'solidFill'), colors);
    // Eigen's writer writes an automatic colour as the palette's at its place, so that colour reads back automatic.
    const automatic = (color: string, index: number) => (color === chartColor(index) ? null : color);
    const markers = type === 'line' && flag(child(group, 'marker')) !== false;
    const seriesColor = (ser: XmlElement) => {
        const shape = child(ser, 'spPr');
        const fill = type === 'line' ? shape && xmlChild(shape, A_NS, 'ln') : shape;
        return fillColor(fill) ?? accent(count(val(child(ser, 'idx'))) ?? 0);
    };
    const style = (ser: XmlElement, index: number): ChartSeriesStyle => ({
        color: automatic(seriesColor(ser), index),
        markers: markers && val(child(child(ser, 'marker'), 'symbol')) !== 'none',
        smooth: type === 'line' && flag(child(ser, 'smooth')) === true,
    });

    const [first] = series;
    const categories = series.map((ser) => child(ser, 'cat')).find(Boolean);
    const numFmt = child(valueAxis, 'numFmt');
    const linked = !numFmt || isOn(xmlAttr(numFmt, '', 'sourceLinked')) === true;
    const format = linked
        ? data === 'cache'
            ? xmlTrimmedText(child(cacheOf(child(first, 'val')), 'formatCode'))
            : undefined
        : xmlAttr(numFmt, '', 'formatCode');
    const blanks = child(chart, 'dispBlanksAs');
    const presentation = {
        type,
        stacking,
        legend: legendPosition(child(chart, 'legend')),
        // CT_DispBlanksAs: present without a val is zero.
        blanks: CHART_BLANKS.find((option) => option === (blanks ? (val(blanks) ?? 'zero') : 'gap')) ?? 'gap',
        categoryAxis: { title: axisTitle(categoryAxis), visible: visible(categoryAxis), reversed },
        valueAxis: {
            title: axisTitle(valueAxis),
            min: numberOf(val(child(scaling, 'min'))),
            max: numberOf(val(child(scaling, 'max'))),
            gridlines: child(valueAxis, 'majorGridlines') !== undefined,
            format:
                format && format !== 'General' && !(stacking === 'percent' && format === PERCENT_AXIS_FORMAT)
                    ? chartLabel(format)
                    : null,
            visible: visible(valueAxis),
        },
    };
    const slices = (total: number): ChartSpec['sliceColors'] => {
        if (type !== 'pie' || !first) return [];
        if (total > MAX_CHART_POINTS) unsupported();
        const points = new Map<number, string>();
        for (const point of children(first, 'dPt')) {
            const index = count(val(child(point, 'idx')));
            const color = fillColor(child(point, 'spPr'));
            if (index !== undefined && color) points.set(index, color);
        }
        const vary = flag(child(group, 'varyColors')) !== false;
        const own = seriesColor(first);
        const colors = Array.from({ length: total }, (_, i) => automatic(points.get(i) ?? (vary ? accent(i) : own), i));
        // A missing slice colour is automatic too.
        while (colors.length > 0 && colors.at(-1) === null) colors.pop();
        return colors;
    };

    if (data === 'cache') {
        const values = series.map((ser) => cachedPoints(cacheOf(child(ser, 'val'))).map(numberOf));
        const cache = cacheOf(categories);
        const categoryFormat = cache?.local.startsWith('num') ? xmlTrimmedText(child(cache, 'formatCode')) : '';
        const label = (point: string | undefined) => {
            const number = categoryFormat && categoryFormat !== 'General' ? numberOf(point) : null;
            return chartLabel(number === null ? (point ?? '') : numberDisplay(number, categoryFormat));
        };
        const labels = cachedPoints(cache).map(label);
        const longest = values.reduce((most, points) => Math.max(most, points.length), 0);
        const length = Math.max(labels.length, longest);
        return {
            ...presentation,
            sliceColors: slices(length),
            data: {
                source: 'inline',
                categories: categories ? labels : Array.from({ length }, (_, i) => String(i + 1)),
                series: series.map((ser, i) => ({
                    ...style(ser, i),
                    name: seriesName(ser),
                    values: values[i],
                })),
            },
        };
    }

    // A literal has no cells to name; an empty c:cat or c:val names none.
    const range = (source: XmlElement | undefined): CellRangeRef | null => {
        const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
        if (ref) return cellRange(xmlTrimmedText(child(ref, 'f')), data.ranges);
        return child(source, 'numLit') || child(source, 'strLit') ? unsupported() : null;
    };
    // The sheet draws a row or a column of values or categories, never an area.
    const line = (ref: CellRangeRef | null) =>
        ref && ref.row[0] !== ref.row[1] && ref.column[0] !== ref.column[1] ? unsupported() : ref;
    const firstValues = line(range(child(first, 'val')));
    let categoryRange = range(categories);
    // A multi-level ref spans a column per level, or a row when the values run across, the innermost last.
    if (categoryRange && child(categories, 'multiLvlStrRef')) {
        const { row, column } = categoryRange;
        categoryRange =
            !firstValues || firstValues.column[0] === firstValues.column[1]
                ? { ...categoryRange, column: [column[1], column[1]] }
                : { ...categoryRange, row: [row[1], row[1]] };
    }
    categoryRange = line(categoryRange);
    const size = firstValues
        ? (firstValues.row[1] - firstValues.row[0] + 1) * (firstValues.column[1] - firstValues.column[0] + 1)
        : 0;
    return {
        ...presentation,
        sliceColors: slices(size),
        data: {
            source: 'range',
            categories: categoryRange,
            series: series.map((ser, i) => {
                const name = child(ser, 'tx');
                return {
                    ...style(ser, i),
                    name: (child(name, 'strRef') && range(name)) ?? seriesName(ser),
                    values: line(range(child(ser, 'val'))),
                };
            }),
        },
    };
}

const GROUPINGS = new Map([
    ['stacked', 'Stacked'],
    ['percentStacked', '100% Stacked'],
]);

// PowerPoint's name for a plot's groups: a group's kind with its depth, direction, grouping, markers, lines or
// wireframe; a volume bar group with a stock group is one stock chart, any other two groups a combo.
function chartName(groups: XmlElement[]): string {
    const kinds = groups.map((group) => group.local).join(' ');
    const stock = (group: XmlElement) =>
        children(group, 'ser').length === 4 ? 'Open-High-Low-Close' : 'High-Low-Close';
    if (kinds === 'barChart stockChart') return `Volume-${stock(groups[1])}`;
    const [group] = groups;
    if (!group || groups.length > 1) return group ? 'Combo' : '';
    const words = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');
    const option = (local: string) => val(child(group, local));
    const grouping = GROUPINGS.get(option('grouping') ?? '');
    const depth = group.local.includes('3D') && '3-D';
    const [first] = children(group, 'ser');
    const symbol = val(child(child(first, 'marker'), 'symbol'));
    const markers = (auto: boolean) => (symbol ? symbol !== 'none' : auto);
    const direction = option('barDir') === 'bar' ? 'Bar' : 'Column';
    switch (group.local) {
        case 'barChart':
        case 'bar3DChart':
            if (depth && option('grouping') === 'standard') return `3-D ${direction}`;
            return words(depth, grouping ?? 'Clustered', direction);
        case 'lineChart':
            return words(grouping, 'Line', flag(child(group, 'marker')) !== false && markers(true) && 'with Markers');
        case 'line3DChart':
            return '3-D Line';
        case 'areaChart':
        case 'area3DChart':
            return words(depth, grouping, 'Area');
        case 'pieChart':
            return 'Pie';
        case 'pie3DChart':
            return '3-D Pie';
        case 'doughnutChart':
            return 'Doughnut';
        case 'ofPieChart':
            return option('ofPieType') === 'bar' ? 'Bar of Pie' : 'Pie of Pie';
        case 'scatterChart': {
            // Excel writes lineMarker for every scatter it makes: its series say which it is.
            const style = option('scatterStyle') ?? 'marker';
            const shape = child(first, 'spPr');
            const line = shape && xmlChild(shape, A_NS, 'ln');
            const lines = line ? !xmlChild(line, A_NS, 'noFill') : style !== 'marker' && style !== 'none';
            if (!lines) return 'Scatter';
            const smooth = flag(child(first, 'smooth')) ?? style.startsWith('smooth');
            const marked = markers(style === 'lineMarker' || style === 'smoothMarker');
            return words('Scatter with', smooth ? 'Smooth' : 'Straight', 'Lines', marked && 'and Markers');
        }
        case 'bubbleChart':
            return flag(child(group, 'bubble3D')) ? '3-D Bubble' : 'Bubble';
        case 'radarChart':
            if (option('radarStyle') === 'filled') return 'Filled Radar';
            return words('Radar', markers(option('radarStyle') === 'marker') && 'with Markers');
        case 'stockChart':
            return stock(group);
        case 'surfaceChart':
        case 'surface3DChart':
            return words(flag(child(group, 'wireframe')) && 'Wireframe', depth ? '3-D Surface' : 'Contour');
        default:
            return '';
    }
}

// Excel's: no title of its own shows the only series' name unless the auto title was deleted; a title element with no
// text shows that name too, or a placeholder when there are more series. A series without a name gives none.
function chartTitle(chart: XmlElement | undefined, groups: XmlElement[]): string {
    const title = child(chart, 'title');
    const text = cachedText(child(title, 'tx'));
    if (text !== undefined) return chartLabel(text);
    if (!title && flag(child(chart, 'autoTitleDeleted')) !== false) return '';
    const series = groups.flatMap((group) => children(group, 'ser'));
    if (series.length === 1) return chartLabel(cachedText(child(series[0], 'tx')) ?? '');
    return title ? 'Chart Title' : '';
}

// Excel shows a placeholder for an axis title element with no text.
function axisTitle(axis: XmlElement | undefined): string {
    const title = child(axis, 'title');
    if (!title) return '';
    return chartLabel(cachedText(child(title, 'tx')) ?? 'Axis Title');
}

function legendPosition(legend: XmlElement | undefined): LegendPosition {
    if (!legend) return 'none';
    return LEGEND_BY_POSITION.get(val(child(legend, 'legendPos')) ?? 'r') ?? 'right';
}

// Excel names a series without a name by its index.
function seriesName(ser: XmlElement | undefined): string {
    const text = cachedText(child(ser, 'tx'));
    return chartLabel(text ?? `Series${(count(val(child(ser, 'idx'))) ?? 0) + 1}`);
}

// A c:tx's text: rich text, a literal, or a ref's cached cells, joined as Excel joins a name over several cells.
function cachedText(tx: XmlElement | undefined): string | undefined {
    if (!tx) return undefined;
    const rich = child(tx, 'rich');
    if (rich) return drawingLines(rich).join(' ').trim();
    const literal = child(tx, 'v');
    if (literal) return xmlText(literal);
    const points = children(child(child(tx, 'strRef'), 'strCache'), 'pt');
    return points.map((point) => xmlTrimmedText(child(point, 'v'))).join(' ');
}

// A c:cat's or c:val's point container: a ref's cache or a literal.
function cacheOf(source: XmlElement | undefined): XmlElement | undefined {
    const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
    return ref
        ? (child(ref, 'numCache') ?? child(ref, 'strCache') ?? child(ref, 'multiLvlStrCache'))
        : (child(source, 'numLit') ?? child(source, 'strLit'));
}

// A cache's points by index, a missing point undefined, a multi-level cache's innermost level. The count comes from
// the file, so it is bounded before anything is built.
function cachedPoints(cache: XmlElement | undefined): (string | undefined)[] {
    const points = children(child(cache, 'lvl') ?? cache, 'pt');
    let total = count(val(child(cache, 'ptCount')));
    if (total === undefined) {
        total = 0;
        for (const point of points) total = Math.max(total, (count(xmlAttr(point, '', 'idx')) ?? -1) + 1);
    }
    if (total > MAX_CHART_POINTS) unsupported();
    const values = new Array<string | undefined>(total).fill(undefined);
    for (const point of points) {
        const index = count(xmlAttr(point, '', 'idx'));
        if (index !== undefined && index < total) values[index] = xmlTrimmedText(child(point, 'v'));
    }
    return values;
}

// A chart's c:f: a sheet's A1 cell or area. null for a ref Excel shows as #REF!; no spec for a shape it can't hold.
// Split at the last '!', not by the engine's sheet prefix: Excel leaves a name of any script's letters unquoted.
function cellRange(formula: string, sheetId: (sheetName: string) => string | undefined): CellRangeRef | null {
    if (formula.includes('#REF!')) return null;
    const bang = formula.lastIndexOf('!');
    if (bang < 1 || formula.startsWith('(')) unsupported();
    const range = parseA1Range(formula.slice(bang + 1));
    if (!range) unsupported();
    const rows: [number, number] = [Math.min(range.start.row, range.end.row), Math.max(range.start.row, range.end.row)];
    const columns: [number, number] = [
        Math.min(range.start.col, range.end.col),
        Math.max(range.start.col, range.end.col),
    ];
    if (rows[1] >= REFERENCE_ROW_COUNT || columns[1] >= REFERENCE_COLUMN_COUNT) unsupported();
    const id = sheetId(unquoteSheetName(formula.slice(0, bang)));
    return id === undefined ? null : { sheetId: id, row: rows, column: columns };
}

// An element's children in the chart namespace, an mc:AlternateContent read as the choice this reader understands.
// The chart-wide text properties' Latin typeface, as a bundled font; a theme font (+mn-lt) or an unbundled one is the default.
function chartFont(root: XmlElement): string {
    let latin = child(root, 'txPr');
    for (const local of ['p', 'pPr', 'defRPr', 'latin']) latin = latin && xmlChild(latin, A_NS, local);
    const typeface = latin && xmlAttr(latin, '', 'typeface');
    return (typeface && bundledFont(typeface)) ?? DEFAULT_CHART_FONT;
}

function elements(element: XmlElement | undefined): XmlElement[] {
    if (!element) return [];
    return xmlElements(element).flatMap((item) => (isAlternateContent(item) ? alternative(item) : [item]));
}

function children(element: XmlElement | undefined, local: string): XmlElement[] {
    return elements(element).filter((item) => hasXmlName(item, C_NS, local));
}

function child(element: XmlElement | undefined, local: string): XmlElement | undefined {
    return elements(element).find((item) => hasXmlName(item, C_NS, local));
}

function val(element: XmlElement | undefined): string | undefined {
    return element && xmlAttr(element, '', 'val');
}

// CT_Boolean: present without a val is true.
function flag(element: XmlElement | undefined): boolean | undefined {
    return element ? (isOn(xmlAttr(element, '', 'val')) ?? true) : undefined;
}

function count(value: string | undefined): number | undefined {
    const number = value?.trim() ? Number(value) : Number.NaN;
    return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function numberOf(value: string | undefined): number | null {
    const number = value?.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? number : null;
}
