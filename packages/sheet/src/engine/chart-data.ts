import { chartLabel, MAX_CHART_POINTS, parseChartSpec } from '@workspace/lib/charts';
import type { SheetChart } from '@workspace/lib/sheets';
import type { CellRangeRef, InlineChartData, RangeChartData } from '@workspace/lib/types/chart';
import { inlineStringText } from './format';
import type { Cell, CellResolver } from './types';

// What the chart layout draws, the shape inline data already has.
export type ResolvedChartData = Pick<InlineChartData, 'categories' | 'series'>;
// 'ref': a ref was deleted, names a missing sheet, or spans rows and columns, Excel's #REF.
export type ChartDataError = 'ref' | 'too-many-points';

// Reads a range chart's cells: values from the computed `v`, labels and names from the display
// text `m` or a rich-text cell's runs, the same strings the grid shows. Hidden rows and columns are
// read like any other.
export function resolveRangeChartData(
    data: RangeChartData,
    resolver: CellResolver,
): ResolvedChartData | ChartDataError {
    const sheetIds = new Set(resolver.getSheets().map((sheet) => sheet.id));
    const usable = (ref: CellRangeRef | null): ref is CellRangeRef =>
        ref !== null && sheetIds.has(ref.sheetId) && (ref.row[0] === ref.row[1] || ref.column[0] === ref.column[1]);
    const { categories, series } = data;
    if (categories !== null && !usable(categories)) return 'ref';
    const valueRefs: CellRangeRef[] = [];
    for (const s of series) {
        if (!usable(s.values) || (typeof s.name !== 'string' && !sheetIds.has(s.name.sheetId))) return 'ref';
        valueRefs.push(s.values);
    }

    // Counted from the refs, so a whole-column selection costs nothing before it is refused.
    const points = valueRefs.reduce((sum, ref) => sum + size(ref), 0);
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
    const resolved = series.map(({ name, values: _values, ...style }, i) => ({
        ...style,
        // A name is one cell, Google's header cell; a wider ref reads its first.
        name: typeof name === 'string' ? name : label(resolver.getCell(name.sheetId, name.row[0], name.column[0])),
        values: cells(valueRefs[i]).map(value),
    }));
    const count = Math.max(0, ...resolved.map((s) => s.values.length));
    return {
        categories: categories ? cells(categories).map(label) : Array.from({ length: count }, (_, i) => String(i + 1)),
        series: resolved,
    };
}

function size(ref: CellRangeRef): number {
    return (ref.row[1] - ref.row[0] + 1) * (ref.column[1] - ref.column[0] + 1);
}

function value(cell: Cell | null): number | null {
    return typeof cell?.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
}

function label(cell: Cell | null): string {
    if (cell?.ct?.t === 'inlineStr') return chartLabel(inlineStringText(cell.ct));
    return chartLabel(String(cell?.m ?? cell?.v ?? ''));
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
