import { chartColor, chartLabel, MAX_CHART_POINTS, parseChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type {
    CellRangeRef,
    ChartData,
    ChartDataError,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import { renderChartSpecSvg } from '@workspace/lib/vector';
import { numberDisplay, richText } from './format';
import type { Cell, CellResolver } from './types';

// Reads a range chart's cells: values from the computed `v`, labels and names from the display
// text `m` or a rich-text cell's runs, the same strings the grid shows. Hidden rows and columns are
// read like any other. A series whose values were deleted is left out, as Google does, and keeps its
// color in the spec for an undo. An automatic color resolves by the series' index in the spec, before
// that, so the series after a deleted one keep the color the editor shows them in.
export function resolveRangeChartData(data: RangeChartData, resolver: CellResolver): ChartData | ChartDataError {
    const sheetIds = new Set(resolver.getSheets().map((sheet) => sheet.id));
    const usable = (ref: CellRangeRef): boolean =>
        sheetIds.has(ref.sheetId) && (ref.row[0] === ref.row[1] || ref.column[0] === ref.column[1]);
    const { categories } = data;
    if (categories !== null && !usable(categories)) return 'ref';
    const series = data.series.flatMap(({ values, color, ...rest }, i) =>
        values ? [{ ...rest, color: color ?? chartColor(i), values }] : [],
    );
    if (series.length === 0) return 'ref';
    for (const s of series) {
        if (!usable(s.values) || (typeof s.name !== 'string' && !sheetIds.has(s.name.sheetId))) return 'ref';
    }

    // Counted from the refs, so a whole-column selection costs nothing before it is refused.
    const points = series.reduce((sum, s) => sum + size(s.values), 0);
    if (points > MAX_CHART_POINTS || (categories !== null && size(categories) > MAX_CHART_POINTS)) {
        return 'too-many-points';
    }

    const cells = (ref: CellRangeRef) => {
        const out: (Cell | null)[] = [];
        for (let r = ref.row[0]; r <= ref.row[1]; r += 1) {
            for (let c = ref.column[0]; c <= ref.column[1]; c += 1) out.push(resolver.getCell(ref.sheetId, r, c));
        }
        return out;
    };
    const resolved = series.map(({ name, values, ...style }) => ({
        ...style,
        name: seriesName(name, resolver),
        values: cells(values).map((cell) => (typeof cell?.v === 'number' && Number.isFinite(cell.v) ? cell.v : null)),
    }));
    const count = Math.max(0, ...resolved.map((s) => s.values.length));
    return {
        categories: categories
            ? cells(categories).map(cellLabel)
            : Array.from({ length: count }, (_, i) => String(i + 1)),
        series: resolved,
    };
}

// A name is one cell, Google's header cell; a wider ref reads its first.
export function seriesName(name: RangeChartSeries['name'], resolver: CellResolver): string {
    return typeof name === 'string' ? name : cellLabel(resolver.getCell(name.sheetId, name.row[0], name.column[0]));
}

// A chart as the editor's overlay and the export draw it: its box, its range data read through the
// resolver, and value ticks in the axis's own format or else the first value cell's, Google's "From
// source data".
export function renderSheetChartSvg(chart: SheetChart, resolver: CellResolver): string {
    const spec = parseChartSpec(chart.spec);
    const range = spec?.data.source === 'range' ? spec.data : null;
    const first = range?.series.find((s) => s.values)?.values;
    const format =
        spec?.valueAxis.format ??
        (first ? resolver.getCell(first.sheetId, first.row[0], first.column[0])?.ct?.fa : undefined);
    return renderChartSpecSvg({
        id: chart.id,
        spec,
        data: range ? resolveRangeChartData(range, resolver) : undefined,
        width: chart.width,
        height: chart.height,
        formatTick: (value) => numberDisplay(value, format),
    });
}

function size(ref: CellRangeRef): number {
    return (ref.row[1] - ref.row[0] + 1) * (ref.column[1] - ref.column[0] + 1);
}

// The text a chart reads from a cell: the string the grid shows, or a rich-text cell's runs.
export function cellLabel(cell: Cell | null): string {
    return chartLabel(String((cell && richText(cell)) ?? cell?.m ?? cell?.v ?? ''));
}

// Rewrites a range chart's refs through `map`, and returns the chart itself when no ref changed or
// its spec is not a readable range chart. A null empties a values or categories ref, and a name ref
// leaves the series unnamed.
export function mapChartRefs(chart: SheetChart, map: (ref: CellRangeRef) => CellRangeRef | null): SheetChart {
    const spec = parseChartSpec(chart.spec);
    if (spec?.data.source !== 'range') return chart;
    let moved = false;
    const move = (ref: CellRangeRef) => {
        const next = map(ref);
        if (next !== ref) moved = true;
        return next;
    };
    const { categories, series } = spec.data;
    const data = {
        ...spec.data,
        categories: categories && move(categories),
        series: series.map((s) => ({
            ...s,
            name: typeof s.name === 'string' ? s.name : (move(s.name) ?? ''),
            values: s.values && move(s.values),
        })),
    };
    return moved ? { ...chart, spec: JSON.stringify({ ...spec, data }) } : chart;
}
