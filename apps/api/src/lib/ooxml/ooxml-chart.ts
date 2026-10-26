// Reads a DrawingML chart part, the same c:chartSpace in a docx, an xlsx and a pptx, as a ChartSpec and the look the
// chart writer maps onto the part. Each format's importer calls it for the charts its drawings name. A chart the spec
// can't draw as the file draws it is never read as a different chart: it is no spec, with its title and kind for the
// caller to show instead. The writer shares this module's tables of OOXML names.

import { gradientStops } from '@workspace/lib/background';
import {
    chartColor,
    chartLabel,
    DEFAULT_CHART_FONT,
    DEFAULT_CHART_SERIES_STYLE,
    defaultChartSpec,
    FLAT_CHART_LOOK,
    isChartSeriesId,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    parseChartSpec,
} from '@workspace/lib/charts';
import { bundledFont } from '@workspace/lib/constants/fonts';
import type {
    CellRangeRef,
    ChartLook,
    ChartPoint,
    ChartSeriesStyle,
    ChartSpec,
    ChartStacking,
    ChartType,
    LegendPosition,
} from '@workspace/lib/types/chart';
import { CHART_BLANKS } from '@workspace/lib/types/chart';
import { solidFill, TRANSPARENT_COLOR } from '@workspace/lib/vector';
// The two engine modules a chart reads, not the engine: a docx or pptx import never evaluates the formula engine.
import { a1RangeRef, parseA1Range, unquoteSheetName } from '@workspace/sheet/engine/a1-notation';
import { numberDisplay } from '@workspace/sheet/engine/format';
import type { XmlElement } from '../core/xml';
import {
    hasXmlName,
    parseXml,
    xmlAttr,
    xmlChild,
    xmlChildren,
    xmlElements,
    xmlText,
    xmlTrimmedText,
} from '../core/xml';
import type { DrawingTheme } from './drawingml';
import { DEFAULT_LINE_WIDTH_EMU, drawingColor, drawingLines, lineWidthEmu, readColorMap } from './drawingml';
import { A_NS, alternativeFor, C_NS, C16_NS, isOn, isOnElement, ooxmlElements } from './ooxml';
import type { OoxmlPackage, Relationship } from './opc';
import { optional, relTarget } from './opc';

// Where a chart's data comes from. A docx or pptx chart is drawn from its caches, which hold every value. An xlsx
// chart's refs name the workbook's own sheets, which the importer gives ids. A ref the reader can't follow, such as a
// literal, a defined name, several areas, an area, a sheet not in the workbook, or a pie's range past its slices,
// brings in the caches' numbers inline instead. Those show, but follow no cell.
type ChartSource = 'cache' | { ranges: (sheetName: string) => string | undefined };

// `name` is PowerPoint's name for the chart's type, as Insert Chart lists it, such as Clustered Column, Pie of Pie or
// Combo. It is empty for a kind PowerPoint has no name for.
export type ChartRead = { spec: ChartSpec } | { unsupported: { title: string; name: string } };

// The package a chart part sits in, whose application draws whatever the part doesn't state.
export type ChartHost = 'docx' | 'xlsx' | 'pptx';

export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

export const CHART_NOT_IMPORTED = 'Chart not imported';
// What follows the kind's name on the line a chart of a kind Eigen can't draw leaves.
export const KIND_NOT_IMPORTED = 'chart not imported';

// ── Tables the writer shares ────────────────────────────────────────────────────────────────────────────────────

const TYPE_BY_GROUP = new Map<string, ChartType>([
    ['barChart', 'column'],
    ['bar3DChart', 'column'],
    ['lineChart', 'line'],
    ['line3DChart', 'line'],
    ['pieChart', 'pie'],
    ['pie3DChart', 'pie'],
]);

// The groups a line chart is drawn from, whose series' line has a width of its own.
const LINE_GROUPS = new Set([...TYPE_BY_GROUP].flatMap(([local, type]) => (type === 'line' ? [local] : [])));

export const STACKING_BY_GROUPING: ReadonlyMap<string, ChartStacking> = new Map<string, ChartStacking>([
    ['clustered', 'none'],
    ['standard', 'none'],
    ['stacked', 'stacked'],
    ['percentStacked', 'percent'],
]);

// The format the writer gives a percent-stacked value axis that has none of its own. It reads back as none.
export const PERCENT_AXIS_FORMAT = '0%';

export const LEGEND_BY_POSITION: ReadonlyMap<string, LegendPosition> = new Map<string, LegendPosition>([
    ['t', 'top'],
    ['b', 'bottom'],
    ['l', 'left'],
    ['r', 'right'],
    ['tr', 'right'],
]);

// ── Finding and weighing a chart ────────────────────────────────────────────────────────────────────────────────

// The c:chartSpace an r:id names. It is read only through a chart relationship, only under the format's charts folder
// (such as word/charts/) and only when it has the chart content type, so a part's own relationships never lead to
// it. A missing or damaged part is undefined, so it costs only its chart.
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

// What a format charges before it reads a chart: the part's elements, plus the points readChart builds from them. A
// cache counts its points by its c:ptCount, else by its last c:pt, whatever it holds. The reader builds each series,
// the categories and the slices, each as long as the longest, before the spec's cap on all points together refuses
// them.
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

// ── The spec ────────────────────────────────────────────────────────────────────────────────────────────────────

// The prefixes this reader understands in a Requires. A Choice that needs more, such as c14's style, falls back.
const alternative = alternativeFor(new Set(['c', 'a', 'r']));

const UNSUPPORTED = new Error('unsupported chart');
// A chart past the spec's caps on points or series. Eigen draws its kind, so it is told apart from one it can't draw.
const TOO_LARGE = new Error('chart too large');

function unsupported(): never {
    throw UNSUPPORTED;
}

function tooLarge(): never {
    throw TOO_LARGE;
}

// Reads the chart as a spec, or as unsupported. Range data that can't be followed is read again from the caches.
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
            JSON.stringify({
                ...chartSpec(chart, plotArea, group, colors, data, chartFont(root)),
                title: { text: title },
            }),
        );
        // The spec is built within the caps on what each part holds, so a spec that doesn't parse holds too much.
        return spec ? { spec } : tooLarge();
    } catch (error) {
        if (error !== UNSUPPORTED && error !== TOO_LARGE) throw error;
        if (data !== 'cache') return readChart(root, { theme, data: 'cache' });
        // A chart refused for its size names no kind, so its line doesn't read as a kind Eigen can't draw.
        return { unsupported: { title, name: error === TOO_LARGE ? '' : chartName(groups) } };
    }
}

function chartSpec(
    chart: XmlElement | undefined,
    plotArea: XmlElement | undefined,
    group: XmlElement,
    colors: DrawingTheme,
    data: ChartSource,
    fontFamily: string,
): Omit<ChartSpec, 'title'> {
    const kind = TYPE_BY_GROUP.get(group.local) ?? unsupported();
    const type = kind === 'column' && val(child(group, 'barDir')) === 'bar' ? 'bar' : kind;
    const grouping = val(child(group, 'grouping')) ?? (type === 'line' ? 'standard' : 'clustered');
    // A pie has no grouping, so it reads as clustered. The spec draws no stacked line, so a line chart must be
    // standard.
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
    // Excel's minMax category axis runs from the origin, which is up a bar chart's side, while Google's runs down it.
    // The spec turns the whole axis rather than the data, since Excel's turns each category's series with it.
    const reversed = (type === 'bar') !== (orientation(categoryAxis) === 'maxMin');
    // A deleted axis, or one whose tick labels are none, shows no labels.
    const visible = (axis: XmlElement | undefined) =>
        isOnElement(child(axis, 'delete')) !== true && val(child(axis, 'tickLblPos')) !== 'none';

    const all = children(group, 'ser');
    if (all.length > MAX_CHART_SERIES) tooLarge();
    const ordered = all
        .map((ser, i) => ({ ser, order: nonNegativeInt(val(child(ser, 'order'))) ?? i }))
        .sort((a, b) => a.order - b.order)
        .map(({ ser }) => ser);
    const series = type === 'pie' ? ordered.slice(0, 1) : ordered;
    const ids = seriesIds(series);
    const accent = (index: number) => {
        const slot = index < 6 ? colors.map.get(`accent${index + 1}`) : undefined;
        return (slot && colors.scheme.get(slot)) ?? chartColor(index);
    };
    const fillColor = (shape: XmlElement | undefined) =>
        drawingColor(shape && xmlChild(shape, A_NS, 'solidFill'), colors);
    // Eigen's writer writes an automatic color as the palette's color at its place, so that color reads back as
    // automatic.
    const automatic = (color: string, index: number) => (color === chartColor(index) ? null : color);
    const markers = type === 'line' && isOnElement(child(group, 'marker')) !== false;
    const seriesColor = (ser: XmlElement) => {
        const shape = child(ser, 'spPr');
        const fill = type === 'line' ? shape && xmlChild(shape, A_NS, 'ln') : shape;
        return fillColor(fill) ?? accent(nonNegativeInt(val(child(ser, 'idx'))) ?? 0);
    };
    const style = (ser: XmlElement, index: number): ChartSeriesStyle => ({
        ...DEFAULT_CHART_SERIES_STYLE,
        color: automatic(seriesColor(ser), index),
        line: { smooth: type === 'line' && isOnElement(child(ser, 'smooth')) === true },
        marker: { visible: markers && val(child(child(ser, 'marker'), 'symbol')) !== 'none' },
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
    const defaults = defaultChartSpec(type, { source: 'inline', categories: [], series: [] });
    const { x, y } = defaults.axes;
    const presentation: Omit<ChartSpec, 'title' | 'points' | 'data'> = {
        chart: {
            type,
            // A CT_DispBlanksAs element without a val means zero.
            blanks: CHART_BLANKS.find((option) => option === (blanks ? (val(blanks) ?? 'zero') : 'gap')) ?? 'gap',
            fontFamily,
        },
        legend: { position: legendPosition(child(chart, 'legend')) },
        axes: {
            x: {
                ...x,
                title: { text: axisTitle(categoryAxis) },
                visible: visible(categoryAxis),
                scale: { ...x.scale, reversed },
            },
            y: {
                ...y,
                title: { text: axisTitle(valueAxis) },
                visible: visible(valueAxis),
                // A pie has no value axis, so it keeps its type's gridlines.
                gridlines: {
                    visible: valueAxis ? child(valueAxis, 'majorGridlines') !== undefined : y.gridlines.visible,
                },
                labels: {
                    format:
                        format && format !== 'General' && !(stacking === 'percent' && format === PERCENT_AXIS_FORMAT)
                            ? chartLabel(format)
                            : null,
                },
                scale: {
                    ...y.scale,
                    min: numberOf(val(child(scaling, 'min'))),
                    max: numberOf(val(child(scaling, 'max'))),
                },
            },
        },
        plots: { ...defaults.plots, [type]: { stacking } },
        series: Object.fromEntries(series.map((ser, i) => [ids[i], style(ser, i)])),
    };
    // A pie's slices are its first series' points. Each takes its c:dPt's color, else the palette's or the series'
    // color as c:varyColors says. A slice in its automatic color is left out.
    const slices = (total: number): ChartSpec['points'] => {
        if (type !== 'pie' || !first) return {};
        if (total > MAX_CHART_POINTS) tooLarge();
        const points = new Map<number, string>();
        for (const point of children(first, 'dPt')) {
            const index = nonNegativeInt(val(child(point, 'idx')));
            const color = fillColor(child(point, 'spPr'));
            if (index !== undefined && color) points.set(index, color);
        }
        const vary = isOnElement(child(group, 'varyColors')) !== false;
        const own = seriesColor(first);
        const colored = Array.from({ length: total }, (_, i): [number, ChartPoint][] => {
            const color = automatic(points.get(i) ?? (vary ? accent(i) : own), i);
            return color === null ? [] : [[i, { color }]];
        }).flat();
        return colored.length > 0 ? { [ids[0]]: Object.fromEntries(colored) } : {};
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
            points: slices(length),
            data: {
                source: 'inline',
                categories: categories ? labels : Array.from({ length }, (_, i) => String(i + 1)),
                series: series.map((ser, i) => ({
                    id: ids[i],
                    name: seriesName(ser),
                    values: values[i],
                })),
            },
        };
    }

    // A literal has no cells to name, so it is unsupported. An empty c:cat or c:val names no cells.
    const range = (source: XmlElement | undefined): CellRangeRef | null => {
        const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
        if (ref) return refOfFormula(xmlTrimmedText(child(ref, 'f')), data.ranges);
        return child(source, 'numLit') || child(source, 'strLit') ? unsupported() : null;
    };
    // A sheet chart draws a row or a column of values or categories, never an area.
    const line = (ref: CellRangeRef | null) =>
        ref && ref.row[0] !== ref.row[1] && ref.column[0] !== ref.column[1] ? unsupported() : ref;
    const firstValues = line(range(child(first, 'val')));
    let categoryRange = range(categories);
    // A multi-level ref spans a column per level, or a row per level when the values run across. Its innermost level is
    // the last, which is the one read.
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
        points: slices(size),
        data: {
            source: 'range',
            categories: categoryRange,
            series: series.map((ser, i) => {
                const name = child(ser, 'tx');
                return {
                    id: ids[i],
                    name: (child(name, 'strRef') && range(name)) ?? seriesName(ser),
                    values: line(range(child(ser, 'val'))),
                };
            }),
        },
    };
}

// A series' id: Office's c16:uniqueId without its GUID's braces, when it is a valid series id no earlier series took.
// Else x- and the c:idx, else that and the series' place. A crafted file that takes even the last one reads as
// unsupported.
function seriesIds(series: XmlElement[]): string[] {
    const ids: string[] = [];
    for (const [i, ser] of series.entries()) {
        const [unique] = elements(child(ser, 'extLst'))
            .flatMap((ext) => xmlChildren(ext, C16_NS, 'uniqueId'))
            .map((element) => xmlAttr(element, '', 'val')?.replace(/^\{(.*)\}$/, '$1'));
        const index = nonNegativeInt(val(child(ser, 'idx'))) ?? i;
        const id = [unique, `x-${index}`].find(
            (candidate) => candidate !== undefined && isChartSeriesId(candidate) && !ids.includes(candidate),
        );
        ids.push(id ?? `x-${index}-${i}`);
    }
    return ids;
}

// Excel's chart title. A chart without a title element shows its only series' name, unless the automatic title was
// deleted. A title element without text shows that name too, or a placeholder when there are more series. A series
// without a name gives no title.
function chartTitle(chart: XmlElement | undefined, groups: XmlElement[]): string {
    const title = child(chart, 'title');
    const text = titleText(child(title, 'tx'));
    if (text !== undefined) return chartLabel(text);
    if (!title && isOnElement(child(chart, 'autoTitleDeleted')) !== false) return '';
    const series = groups.flatMap((group) => children(group, 'ser'));
    if (series.length === 1) return chartLabel(titleText(child(series[0], 'tx')) ?? '');
    return title ? 'Chart Title' : '';
}

// Excel shows a placeholder for an axis title element without text.
function axisTitle(axis: XmlElement | undefined): string {
    const title = child(axis, 'title');
    if (!title) return '';
    return chartLabel(titleText(child(title, 'tx')) ?? 'Axis Title');
}

// A title's text without the spaces at its ends. The writer writes a title as rich text, which reads trimmed, so a
// title from a cell reads the same on a round trip.
function titleText(tx: XmlElement | undefined): string | undefined {
    return cachedText(tx)?.trim();
}

function legendPosition(legend: XmlElement | undefined): LegendPosition {
    if (!legend) return 'none';
    return LEGEND_BY_POSITION.get(val(child(legend, 'legendPos')) ?? 'r') ?? 'right';
}

// Excel names a series without a name by its index.
function seriesName(ser: XmlElement | undefined): string {
    const text = cachedText(child(ser, 'tx'));
    return chartLabel(text ?? `Series${(nonNegativeInt(val(child(ser, 'idx'))) ?? 0) + 1}`);
}

// A c:tx's text: rich text, a literal, or a ref's cached cells, joined as Excel joins a name over several cells. A
// label is one line, so a line break in a cell becomes a space, as one in rich text does.
function cachedText(tx: XmlElement | undefined): string | undefined {
    if (!tx) return undefined;
    const rich = child(tx, 'rich');
    if (rich) return drawingLines(rich).join(' ').trim();
    const literal = child(tx, 'v');
    const points = children(child(child(tx, 'strRef'), 'strCache'), 'pt');
    const text = literal ? xmlText(literal) : points.map(pointText).join(' ');
    return text.replace(/\r?\n|\r/g, ' ');
}

// A c:cat's or c:val's container of points: a ref's cache, or a literal.
function cacheOf(source: XmlElement | undefined): XmlElement | undefined {
    const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
    return ref
        ? (child(ref, 'numCache') ?? child(ref, 'strCache') ?? child(ref, 'multiLvlStrCache'))
        : (child(source, 'numLit') ?? child(source, 'strLit'));
}

// A cache's points by index, with a missing point undefined. A multi-level cache gives its innermost level. The count
// comes from the file, so it is checked against the cap before anything is built.
function cachedPoints(cache: XmlElement | undefined): (string | undefined)[] {
    const points = children(child(cache, 'lvl') ?? cache, 'pt');
    let total = nonNegativeInt(val(child(cache, 'ptCount')));
    if (total === undefined) {
        total = 0;
        for (const point of points) total = Math.max(total, (nonNegativeInt(xmlAttr(point, '', 'idx')) ?? -1) + 1);
    }
    if (total > MAX_CHART_POINTS) tooLarge();
    const values = new Array<string | undefined>(total).fill(undefined);
    for (const point of points) {
        const index = nonNegativeInt(xmlAttr(point, '', 'idx'));
        if (index !== undefined && index < total) values[index] = pointText(point);
    }
    return values;
}

// A point's c:v as written. A label keeps its spaces, as Excel shows them, and a number reads the same either way.
function pointText(point: XmlElement): string {
    const value = child(point, 'v');
    return value ? xmlText(value) : '';
}

// A chart's c:f as a sheet's A1 cell or area. A ref Excel shows as #REF! is null, and a shape a range can't hold is
// unsupported. The ref is split at its last '!' rather than by the engine's sheet prefix, because Excel leaves a sheet
// name of any script's letters unquoted.
function refOfFormula(formula: string, sheetId: (sheetName: string) => string | undefined): CellRangeRef | null {
    if (formula.includes('#REF!')) return null;
    const bang = formula.lastIndexOf('!');
    if (bang < 1 || formula.startsWith('(')) unsupported();
    const range = parseA1Range(formula.slice(bang + 1));
    const ref = (range && a1RangeRef(range)) ?? unsupported();
    const id = sheetId(unquoteSheetName(formula.slice(0, bang))) ?? unsupported();
    return { sheetId: id, ...ref };
}

// The Latin typeface of the chart-wide text properties, as a bundled font. A theme font (+mn-lt) or a font Eigen
// doesn't bundle reads as the default.
function chartFont(root: XmlElement): string {
    let latin = child(root, 'txPr');
    for (const local of ['p', 'pPr', 'defRPr', 'latin']) latin = latin && xmlChild(latin, A_NS, local);
    const typeface = latin && xmlAttr(latin, '', 'typeface');
    return (typeface && bundledFont(typeface)) ?? DEFAULT_CHART_FONT;
}

// ── A chart the spec cannot draw ────────────────────────────────────────────────────────────────────────────────

// What a format shows in place of a chart readChart can't draw: which kind it was, and its title.
export function droppedChart({ title, name }: { title: string; name: string }): string[] {
    const label = name ? `${name} ${KIND_NOT_IMPORTED}` : CHART_NOT_IMPORTED;
    return title ? [label, title] : [label];
}

const GROUPINGS = new Map([
    ['stacked', 'Stacked'],
    ['percentStacked', '100% Stacked'],
]);

// PowerPoint's name for a plot's groups. One group is named by its kind with its depth, direction, grouping, markers,
// lines or wireframe. A volume bar group with a stock group is one stock chart, and any other two groups are a combo.
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
            return words(
                grouping,
                'Line',
                isOnElement(child(group, 'marker')) !== false && markers(true) && 'with Markers',
            );
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
            // Excel writes lineMarker for every scatter chart it makes, so the series tell which kind it is.
            const style = option('scatterStyle') ?? 'marker';
            const shape = child(first, 'spPr');
            const line = shape && xmlChild(shape, A_NS, 'ln');
            const lines = line ? !xmlChild(line, A_NS, 'noFill') : style !== 'marker' && style !== 'none';
            if (!lines) return 'Scatter';
            const smooth = isOnElement(child(first, 'smooth')) ?? style.startsWith('smooth');
            const marked = markers(style === 'lineMarker' || style === 'smoothMarker');
            return words('Scatter with', smooth ? 'Smooth' : 'Straight', 'Lines', marked && 'and Markers');
        }
        case 'bubbleChart':
            return isOnElement(child(group, 'bubble3D')) ? '3-D Bubble' : 'Bubble';
        case 'radarChart':
            if (option('radarStyle') === 'filled') return 'Filled Radar';
            return words('Radar', markers(option('radarStyle') === 'marker') && 'with Markers');
        case 'stockChart':
            return stock(group);
        case 'surfaceChart':
        case 'surface3DChart':
            return words(isOnElement(child(group, 'wireframe')) && 'Wireframe', depth ? '3-D Surface' : 'Contour');
        default:
            return '';
    }
}

// ── The look ────────────────────────────────────────────────────────────────────────────────────────────────────

// Where a part states no look of its own, Office draws chart style 2's automatic look. LibreOffice's oox chart
// ObjectFormatter reads it the same way (spChartSpaceFill, spAxisLines, spMajorGridLines, PptGraphicHelper). The
// background is bg1, but none on a slide, and every line is tx1 at a 75% tint, 9525 EMU wide.
const BG1 = automaticShape('<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>');
const AUTOMATIC_BACKGROUND: Record<ChartHost, XmlElement | undefined> = {
    docx: BG1,
    xlsx: BG1,
    pptx: automaticShape('<a:noFill/>'),
};
const AUTOMATIC_LINE = automaticShape(
    '<a:solidFill><a:schemeClr val="tx1"><a:tint val="75000"/></a:schemeClr></a:solidFill>',
);
// A line series' own width where it states none, 2.25 pt, as Office draws it.
const AUTOMATIC_SERIES_WIDTH = 28575;

function automaticShape(fill: string): XmlElement | undefined {
    return parseXml(`<a:spPr xmlns:a="${A_NS}">${fill}</a:spPr>`) ?? undefined;
}

// The look writeChart maps onto the part, read back. The background comes from c:chartSpace's c:spPr. The label
// color comes from its c:txPr, else from the theme's tx1, as Office draws a label without one. The stroke's color
// and width come from the category axis's line, as the writer strokes every axis and gridline with it. An axis Office
// draws no line along still shows its gridlines, so then the stroke is theirs. A line chart's series width is its
// first series' line's. A gradient reads as its middle color and a pattern as its foreground, since the writer writes
// one color. `emuPerPx` is how many EMU one px of the chart's own box is in the file. A pie has no stroke to read, so
// it reads flat.
export function readChartPartLook(
    root: XmlElement,
    { theme, emuPerPx, host }: { theme: DrawingTheme; emuPerPx: number; host: ChartHost },
): Pick<ChartLook, 'fill' | 'color' | 'strokeColor' | 'strokeWidth' | 'seriesStrokeWidth'> {
    const colors = chartColors(root, theme);
    const drawn = (shape: XmlElement | undefined): string | undefined => {
        if (!shape) return undefined;
        if (xmlChild(shape, A_NS, 'noFill')) return TRANSPARENT_COLOR;
        const gradient = xmlChild(shape, A_NS, 'gradFill');
        if (gradient) return gradientMiddle(gradient, colors);
        const pattern = xmlChild(shape, A_NS, 'pattFill');
        return drawingColor(pattern ? xmlChild(pattern, A_NS, 'fgClr') : xmlChild(shape, A_NS, 'solidFill'), colors);
    };
    const lineOf = (owner: XmlElement | undefined) => {
        const shape = child(owner, 'spPr');
        return shape && xmlChild(shape, A_NS, 'ln');
    };
    const widthOf = (line: XmlElement | undefined, fallbackEmu: number) => {
        const width = lineWidthEmu(line && xmlAttr(line, '', 'w')) ?? fallbackEmu;
        return Math.round((width / emuPerPx) * 100) / 100;
    };
    let text = child(root, 'txPr');
    for (const local of ['p', 'pPr', 'defRPr']) text = text && xmlChild(text, A_NS, local);
    const tx1 = colors.map.get('tx1');
    const background = drawn(child(root, 'spPr')) ?? drawn(AUTOMATIC_BACKGROUND[host]);
    const plotArea = child(child(root, 'chart'), 'plotArea');
    const axis = child(plotArea, 'catAx') ?? child(plotArea, 'dateAx');
    const gridlines = child(child(plotArea, 'valAx'), 'majorGridlines');
    const axisLine = lineOf(axis);
    const line = gridlines && drawn(axisLine) === TRANSPARENT_COLOR ? lineOf(gridlines) : axisLine;
    const strokeWidth = axis ? widthOf(line, DEFAULT_LINE_WIDTH_EMU) : FLAT_CHART_LOOK.strokeWidth;
    const lineGroup = elements(plotArea).find((group) => group.ns === C_NS && LINE_GROUPS.has(group.local));
    const seriesWidth = lineGroup && widthOf(lineOf(child(lineGroup, 'ser')), AUTOMATIC_SERIES_WIDTH);
    return {
        fill: background ? solidFill(background) : FLAT_CHART_LOOK.fill,
        color: drawn(text) ?? (tx1 && colors.scheme.get(tx1)) ?? FLAT_CHART_LOOK.color,
        strokeWidth,
        // A series drawn at the stroke's width is left unset, so the Stroke row still moves it.
        ...(seriesWidth !== undefined && seriesWidth !== strokeWidth && { seriesStrokeWidth: seriesWidth }),
        strokeColor: axis
            ? (drawn(line) ?? drawn(AUTOMATIC_LINE) ?? FLAT_CHART_LOOK.strokeColor)
            : FLAT_CHART_LOOK.strokeColor,
    };
}

// The color halfway along a gradient's stops that show a color, by position, as the writer writes a gradient
// background.
function gradientMiddle(gradient: XmlElement, colors: DrawingTheme): string | undefined {
    const list = xmlChild(gradient, A_NS, 'gsLst');
    const stops = (list ? xmlChildren(list, A_NS, 'gs') : [])
        .map((stop) => ({ color: drawingColor(stop, colors), at: Number(xmlAttr(stop, '', 'pos')) || 0 }))
        .filter((stop) => stop.color !== undefined)
        .sort((a, b) => a.at - b.at);
    const from = stops[0]?.color;
    const to = stops.at(-1)?.color;
    if (!from || !to) return undefined;
    const { color, opacity } = gradientStops(from, to, 3)[1];
    const alpha = Math.round(opacity * 255)
        .toString(16)
        .padStart(2, '0');
    return opacity < 1 ? `${color}${alpha}` : color;
}

// ── Elements ────────────────────────────────────────────────────────────────────────────────────────────────────

// The host's colors through the part's own c:clrMapOvr, which replaces the host's color map.
function chartColors(root: XmlElement, theme: DrawingTheme): DrawingTheme {
    const override = child(root, 'clrMapOvr');
    return override ? { scheme: theme.scheme, map: readColorMap(override) } : theme;
}

// An element's children, with each mc:AlternateContent read as the branch this reader understands.
function elements(element: XmlElement | undefined): XmlElement[] {
    return element ? ooxmlElements(element, alternative) : [];
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

function nonNegativeInt(value: string | undefined): number | undefined {
    const number = value?.trim() ? Number(value) : Number.NaN;
    return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function numberOf(value: string | undefined): number | null {
    const number = value?.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? number : null;
}
