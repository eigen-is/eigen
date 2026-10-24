// A sheet chart's range data: reading its cells, drawing it, inlining it for a copy, and moving its refs through a row
// op or a copied sheet. The writers apply a change onto the spec as stored, so a key this build doesn't know survives.

import {
    applyChartSpecChange,
    chartColor,
    chartLabel,
    exceedsChartSpecBytes,
    MAX_CHART_POINTS,
    parseChartSpec,
    readChartLook,
    readChartSpec,
} from '@workspace/lib/charts';
import { isRecord } from '@workspace/lib/guards';
import type { SheetChart } from '@workspace/lib/sheets';
import { sheetFloatingBox } from '@workspace/lib/sheets';
import type {
    CellRangeRef,
    ChartData,
    ChartDataError,
    ChartSpec,
    ChartSpecChange,
    RangeChartData,
    RangeChartSeries,
} from '@workspace/lib/types/chart';
import { renderChartSpecSvg } from '@workspace/lib/vector';
import { cellDisplay, numberDisplay } from './format';
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

// A chart as the editor's overlay and the export draw it: its box clamped as stored, in the look it stores, its range
// data read through the resolver, and value ticks in the axis's own format or else the first value cell's, Google's
// "From source data".
export function renderSheetChartSvg(chart: SheetChart, resolver: CellResolver): string {
    const spec = parseChartSpec(chart.spec);
    const range = spec?.data.source === 'range' ? spec.data : null;
    const format = spec ? valueFormat(spec, resolver) : undefined;
    const { width, height } = sheetFloatingBox(chart);
    return renderChartSpecSvg({
        id: chart.id,
        spec,
        data: range ? resolveRangeChartData(range, resolver) : undefined,
        width,
        height,
        look: readChartLook(chart),
        formatTick: (value) => numberDisplay(value, format),
    });
}

// The value axis's own format, or for a range chart the first value cell's.
function valueFormat(spec: ChartSpec, resolver: CellResolver): string | undefined {
    if (spec.valueAxis.format !== null) return spec.valueAxis.format;
    const first = spec.data.source === 'range' ? spec.data.series.find((s) => s.values)?.values : null;
    return first ? resolver.getCell(first.sheetId, first.row[0], first.column[0])?.ct?.fa : undefined;
}

// The chart as a copy carries it to a host with no cells: its ranges read into inline data, and the source
// cells' tick format written on the axis. An automatic color stays automatic unless a deleted series before
// it would shift its index, and an inline chart is its stored string. A ref this build doesn't know is left out,
// as it would name cells the host doesn't have. Null for a chart that draws #REF!, too much data or nothing, or
// whose numbers pass the spec's size limit.
export function inlineChartSpec(chart: SheetChart, resolver: CellResolver): string | null {
    const { stored, spec } = readChartSpec(chart.spec);
    if (spec?.data.source !== 'range') return spec ? chart.spec : null;
    const resolved = resolveRangeChartData(spec.data, resolver);
    if (typeof resolved === 'string') return null;
    const kept = spec.data.series.flatMap(({ values, color }, i) => (values ? [{ color, i }] : []));
    const change: ChartSpecChange = [
        { op: 'set', path: ['data'], value: walkRefs(stored['data'], () => undefined) },
        { op: 'set', path: ['data', 'source'], value: 'inline' },
        { op: 'set', path: ['data', 'categories'], value: resolved.categories },
        {
            op: 'set',
            path: ['data', 'series'],
            value: resolved.series.map((s, j) =>
                kept[j].color === null && kept[j].i === j ? { ...s, color: null } : s,
            ),
        },
        { op: 'set', path: ['valueAxis', 'format'], value: valueFormat(spec, resolver) ?? null },
    ];
    const inline = JSON.stringify(applyChartSpecChange(stored, change));
    return exceedsChartSpecBytes(inline) ? null : inline;
}

function size(ref: CellRangeRef): number {
    return (ref.row[1] - ref.row[0] + 1) * (ref.column[1] - ref.column[0] + 1);
}

// The text a chart reads from a cell: the string the grid shows, or a rich-text cell's runs.
export function cellLabel(cell: Cell | null): string {
    return chartLabel(String(cellDisplay(cell) ?? ''));
}

// Rewrites a range chart's refs through `map`, and returns the chart itself when no ref changed or its
// stored data is not range data. Every ref on the data or a series moves, under any key, so a ref this build
// doesn't know moves too, even in a chart it can't draw. A null empties a ref, and a name ref leaves the series
// unnamed. `slices` rewrites the slice colors of a chart this build reads, given the ref the slices run along
// before the map: the categories, or the first drawn series' values for a chart without them.
export function mapChartRefs(
    chart: SheetChart,
    map: (ref: CellRangeRef) => CellRangeRef | null,
    slices?: (colors: ChartSpec['sliceColors'], ref: CellRangeRef) => ChartSpec['sliceColors'],
): SheetChart {
    const { stored, spec } = readChartSpec(chart.spec);
    if (!isRecord(stored['data']) || stored['data']['source'] !== 'range') return chart;
    let moved = false;
    const data = walkRefs(stored['data'], (ref, key) => {
        const next = map(ref);
        if (next !== ref) moved = true;
        return next ?? (key === 'name' ? '' : null);
    });
    if (!moved) return chart;
    const change: ChartSpecChange = [{ op: 'set', path: ['data'], value: data }];
    const range = spec?.data.source === 'range' ? spec.data : null;
    const along = range && (range.categories ?? range.series.find((s) => s.values)?.values);
    if (spec && slices && along)
        change.push({ op: 'set', path: ['sliceColors'], value: slices(spec.sliceColors, along) });
    return { ...chart, spec: JSON.stringify(applyChartSpecChange(stored, change)) };
}

// A record shaped as a CellRangeRef. A key beside its three is accepted, as the reader accepts it.
function isRef(value: unknown): value is CellRangeRef {
    const bounds = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger);
    return isRecord(value) && typeof value['sheetId'] === 'string' && bounds(value['row']) && bounds(value['column']);
}

// Stored data with every ref passed through `map`, which is told the key it sits under; undefined leaves it out. A ref
// sits on the data or on one of its series, so nothing deeper is walked.
function walkRefs(data: unknown, map: (ref: CellRangeRef, key: string) => unknown): unknown {
    const walk = (record: Record<string, unknown>) =>
        Object.fromEntries(
            Object.entries(record).flatMap(([key, value]) => {
                const next = isRef(value) ? map(value, key) : value;
                return next === undefined ? [] : [[key, next]];
            }),
        );
    if (!isRecord(data)) return data;
    const walked = walk(data);
    const series = data['series'];
    if (Array.isArray(series)) walked['series'] = series.map((item) => (isRecord(item) ? walk(item) : item));
    return walked;
}
