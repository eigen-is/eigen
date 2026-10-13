import { chartColor, chartLabel, MAX_CHART_POINTS, MAX_CHART_SERIES, parseChartSpec } from '@workspace/lib/charts';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import {
    type CellRangeRef,
    CHART_BLANKS,
    type ChartSeriesStyle,
    type ChartSpec,
    type ChartType,
    type LegendPosition,
} from '@workspace/lib/types/chart';
import { type DrawingTheme, drawingColor, drawingLines, readColorMap } from './drawingml';
import { A_NS, alternativeFor, C_NS, isAlternateContent, isOn } from './ooxml';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText, xmlTrimmedText } from './xml';

// A DrawingML chart part, c:chartSpace, the same in a docx, an xlsx and a pptx, read into a ChartSpec. A chart the spec
// can't draw as the file does is no spec, with its title for the caller to show instead: never a different chart.

// docx and pptx draw from the caches, which hold every value; an xlsx's refs name its own sheets, by the importer's ids.
export type ChartSource = 'cache' | { ranges: (sheetName: string) => string | undefined };

export type ChartRead = { spec: ChartSpec } | { unsupported: { title: string; type: string } };

const TYPES = new Map<string, ChartType>([
    ['barChart', 'column'],
    ['bar3DChart', 'column'],
    ['lineChart', 'line'],
    ['line3DChart', 'line'],
    ['pieChart', 'pie'],
    ['pie3DChart', 'pie'],
]);

const LEGEND_POSITIONS = new Map<string, LegendPosition>([
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

export function readChart(root: XmlElement, options: { theme: DrawingTheme; data: ChartSource }): ChartRead {
    const chart = hasXmlName(root, C_NS, 'chartSpace') ? child(root, 'chart') : undefined;
    const plotArea = child(chart, 'plotArea');
    const groups = elements(plotArea).filter((element) => element.ns === C_NS && element.local.endsWith('Chart'));
    const title = chartTitle(chart, groups);
    const type = groups.map((group) => group.local).join('+');
    try {
        const [group] = groups;
        if (!group || groups.length > 1) unsupported();
        const spec = parseChartSpec(JSON.stringify(chartSpec(root, group, title, options)));
        if (spec) return { spec };
    } catch (error) {
        if (error !== UNSUPPORTED) throw error;
    }
    return { unsupported: { title, type } };
}

function chartSpec(
    root: XmlElement,
    group: XmlElement,
    title: string,
    { theme, data }: { theme: DrawingTheme; data: ChartSource },
): ChartSpec {
    const chart = child(root, 'chart');
    const plotArea = child(chart, 'plotArea');
    const kind = TYPES.get(group.local) ?? unsupported();
    const type = kind === 'column' && val(child(group, 'barDir')) === 'bar' ? 'bar' : kind;
    const grouping = val(child(group, 'grouping')) ?? (type === 'line' ? 'standard' : 'clustered');
    const stacked = type !== 'line' && type !== 'pie' && grouping === 'stacked';
    if (type === 'line' ? grouping !== 'standard' : !stacked && !['clustered', 'standard'].includes(grouping)) {
        unsupported();
    }
    const valueAxes = children(plotArea, 'valAx');
    const categoryAxes = [...children(plotArea, 'catAx'), ...children(plotArea, 'dateAx')];
    const [valueAxis] = valueAxes;
    const scaling = child(valueAxis, 'scaling');
    if (valueAxes.length > 1 || categoryAxes.length > 1 || child(scaling, 'logBase')) unsupported();

    const all = children(group, 'ser');
    if (all.length > MAX_CHART_SERIES) unsupported();
    const ordered = all
        .map((ser, i) => ({ ser, order: count(val(child(ser, 'order'))) ?? i }))
        .sort((a, b) => a.order - b.order)
        .map(({ ser }) => ser);
    const series = type === 'pie' ? ordered.slice(0, 1) : ordered;
    const override = child(root, 'clrMapOvr');
    const colors = override ? { scheme: theme.scheme, map: readColorMap(override) } : theme;
    const accent = (index: number) => {
        const slot = index < 6 ? colors.map.get(`accent${index + 1}`) : undefined;
        return (slot && colors.scheme.get(slot)) ?? chartColor(index);
    };
    const fillColor = (shape: XmlElement | undefined) =>
        drawingColor(shape && xmlChild(shape, A_NS, 'solidFill'), colors);
    const style = (ser: XmlElement): ChartSeriesStyle => {
        const shape = child(ser, 'spPr');
        const fill = type === 'line' ? shape && xmlChild(shape, A_NS, 'ln') : shape;
        const symbol = val(child(child(ser, 'marker'), 'symbol'));
        return {
            color: fillColor(fill) ?? accent(count(val(child(ser, 'idx'))) ?? 0),
            markers: type === 'line' && symbol !== 'none' && flag(child(group, 'marker')) !== false,
            smooth: type === 'line' && flag(child(ser, 'smooth')) === true,
        };
    };

    const [first] = series;
    const categories = series.map((ser) => child(ser, 'cat')).find(Boolean);
    const numFmt = child(valueAxis, 'numFmt');
    const linked = !numFmt || isOn(xmlAttr(numFmt, '', 'sourceLinked')) === true;
    const valueCache = child(child(child(first, 'val'), 'numRef'), 'numCache');
    const format = linked
        ? data === 'cache'
            ? xmlTrimmedText(child(valueCache, 'formatCode'))
            : undefined
        : xmlAttr(numFmt, '', 'formatCode');
    const blanks = val(child(chart, 'dispBlanksAs'));
    const presentation = {
        type,
        stacked,
        title,
        legend: legendPosition(child(chart, 'legend')),
        blanks: CHART_BLANKS.find((option) => option === blanks) ?? 'gap',
        categoryAxis: { title: axisTitle(categoryAxes[0]) },
        valueAxis: {
            title: axisTitle(valueAxis),
            min: numberOf(val(child(scaling, 'min'))),
            max: numberOf(val(child(scaling, 'max'))),
            gridlines: child(valueAxis, 'majorGridlines') !== undefined,
            format: format && format !== 'General' ? chartLabel(format) : null,
        },
    };
    const slices = (total: number): string[] => {
        if (type !== 'pie' || !first) return [];
        if (total > MAX_CHART_POINTS) unsupported();
        const points = new Map<number, string>();
        for (const point of children(first, 'dPt')) {
            const index = count(val(child(point, 'idx')));
            const color = fillColor(child(point, 'spPr'));
            if (index !== undefined && color) points.set(index, color);
        }
        const vary = flag(child(group, 'varyColors')) !== false;
        const own = style(first).color;
        return Array.from({ length: total }, (_, i) => points.get(i) ?? (vary ? accent(i) : own));
    };

    if (data === 'cache') {
        const values = series.map((ser) => cachedPoints(child(ser, 'val')).map(numberOf));
        const longest = values.reduce((most, points) => Math.max(most, points.length), 0);
        const labels = categories
            ? cachedPoints(categories).map((point) => chartLabel(point ?? ''))
            : Array.from({ length: longest }, (_, i) => String(i + 1));
        return {
            ...presentation,
            sliceColors: slices(Math.max(labels.length, longest)),
            data: {
                source: 'inline',
                categories: labels,
                series: series.map((ser, i) => ({ ...style(ser), name: seriesName(ser), values: values[i] })),
            },
        };
    }

    // A literal has no cells to name; an empty c:cat or c:val names none.
    const range = (source: XmlElement | undefined): CellRangeRef | null => {
        const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
        if (ref) return cellRange(xmlTrimmedText(child(ref, 'f')), data.ranges);
        return child(source, 'numLit') || child(source, 'strLit') ? unsupported() : null;
    };
    const firstValues = range(child(first, 'val'));
    let categoryRange = range(categories);
    // A multi-level ref spans a column per level, or a row when the values run across, the innermost last.
    if (categoryRange && child(categories, 'multiLvlStrRef')) {
        const { row, column } = categoryRange;
        categoryRange =
            !firstValues || firstValues.column[0] === firstValues.column[1]
                ? { ...categoryRange, column: [column[1], column[1]] }
                : { ...categoryRange, row: [row[1], row[1]] };
    }
    const size = firstValues
        ? (firstValues.row[1] - firstValues.row[0] + 1) * (firstValues.column[1] - firstValues.column[0] + 1)
        : 0;
    return {
        ...presentation,
        sliceColors: slices(size),
        data: {
            source: 'range',
            categories: categoryRange,
            series: series.map((ser) => {
                const name = child(ser, 'tx');
                return {
                    ...style(ser),
                    name: (child(name, 'strRef') && range(name)) ?? seriesName(ser),
                    values: range(child(ser, 'val')),
                };
            }),
        },
    };
}

// Excel's: no title of its own shows the only series' name unless the auto title was deleted; a title element with no
// text shows that name too, or a placeholder when there are more series.
function chartTitle(chart: XmlElement | undefined, groups: XmlElement[]): string {
    const title = child(chart, 'title');
    const text = cachedText(child(title, 'tx'));
    if (text !== undefined) return chartLabel(text);
    if (!title && flag(child(chart, 'autoTitleDeleted')) !== false) return '';
    const series = groups.flatMap((group) => children(group, 'ser'));
    if (series.length === 1) return seriesName(series[0]);
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
    return LEGEND_POSITIONS.get(val(child(legend, 'legendPos')) ?? 'r') ?? 'right';
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

// A c:cat's or c:val's points by index, a missing point undefined: a ref's cache or a literal, a multi-level cache's
// innermost level. The count comes from the file, so it is bounded before anything is built.
function cachedPoints(source: XmlElement | undefined): (string | undefined)[] {
    const ref = child(source, 'numRef') ?? child(source, 'strRef') ?? child(source, 'multiLvlStrRef');
    const cache = ref
        ? (child(ref, 'numCache') ?? child(ref, 'strCache') ?? child(ref, 'multiLvlStrCache'))
        : (child(source, 'numLit') ?? child(source, 'strLit'));
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
function cellRange(formula: string, sheetId: (sheetName: string) => string | undefined): CellRangeRef | null {
    if (formula.includes('#REF!')) return null;
    const bang = formula.lastIndexOf('!');
    if (bang < 1 || formula.startsWith('(')) unsupported();
    const sheet = formula.slice(0, bang);
    const quoted = sheet.length > 1 && sheet.startsWith("'") && sheet.endsWith("'");
    const [from, to = from, ...rest] = formula.slice(bang + 1).split(':');
    const start = cellOf(from);
    const end = cellOf(to);
    if (!start || !end || rest.length > 0) unsupported();
    const id = sheetId(quoted ? sheet.slice(1, -1).replaceAll("''", "'") : sheet);
    if (id === undefined) return null;
    return {
        sheetId: id,
        row: [Math.min(start[0], end[0]), Math.max(start[0], end[0])],
        column: [Math.min(start[1], end[1]), Math.max(start[1], end[1])],
    };
}

// Zero-based [row, column] inside Excel's grid.
function cellOf(ref: string | undefined): [number, number] | undefined {
    const match = ref && /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref);
    if (!match) return undefined;
    let column = 0;
    for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
    const row = Number(match[2]);
    return column <= REFERENCE_COLUMN_COUNT && row <= REFERENCE_ROW_COUNT ? [row - 1, column - 1] : undefined;
}

// An element's children in the chart namespace, an mc:AlternateContent read as the choice this reader understands.
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
