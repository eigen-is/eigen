// The stored-chart codec. A chart is one JSON string wherever it lives (a canvas element field, a docs
// node attribute, a SheetChart), and parseChartSpec is the one reader every surface and importer runs.
// Strict: anything malformed or over a hard limit reads as null, never a partial chart, never a throw.

import { stripNonXmlChars } from '../core/xml';
import {
    type CellRangeRef,
    CHART_BLANKS,
    CHART_TYPES,
    type ChartSeriesStyle,
    type ChartSpec,
    type ChartType,
    type InlineChartData,
    type InlineChartSeries,
    LEGEND_POSITIONS,
    type RangeChartData,
    type RangeChartSeries,
} from '../types/chart';
import { isColorToken } from '../vector/fill';
import { prop } from '../vector/types';

// Hard limits: every peer lays out and paints whatever is stored, so they bound one chart's cost.
// Range data counts its points when the sheet resolves it, since a selection can outgrow the limit.
export const MAX_CHART_SPEC_BYTES = 64 * 1024;
export const MAX_CHART_SERIES = 32;
export const MAX_CHART_POINTS = 2000;
export const MAX_CHART_LABEL_LENGTH = 200;

// What the Edit data grid edits; an imported chart over these opens its data read-only.
export const INLINE_GRID_MAX_SERIES = 12;
export const INLINE_GRID_MAX_CATEGORIES = 200;

// The dataviz reference palette's eight slots plus four, ordered so every neighbor, the last and the
// first included, passes its colorblind and normal-vision separation checks on a light surface.
export const CHART_PALETTE = [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#6250d6',
    '#e34948',
    '#0f9bb5',
    '#b0662a',
    '#a24fc9',
    '#7a9a00',
] as const;

export function chartColor(index: number): string {
    return CHART_PALETTE[index % CHART_PALETTE.length];
}

export function exceedsInlineGridLimits(data: InlineChartData): boolean {
    const rows = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return data.series.length > INLINE_GRID_MAX_SERIES || rows > INLINE_GRID_MAX_CATEGORIES;
}

// Google's sample for Insert → Chart.
export function sampleChartSpec(type: ChartType): ChartSpec {
    const categories = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];
    const periods = [
        { name: 'Period 1', values: [42, 65, 38, 80] },
        { name: 'Period 2', values: [58, 47, 71, 63] },
    ];
    const pie = type === 'pie';
    return {
        type,
        stacked: false,
        title: 'Points scored',
        legend: pie ? 'none' : 'top',
        blanks: 'gap',
        categoryAxis: { title: '' },
        valueAxis: { title: '', min: null, max: null, gridlines: true, format: null },
        sliceColors: pie ? categories.map((_, i) => chartColor(i)) : [],
        data: {
            source: 'inline',
            categories,
            series: (pie ? periods.slice(0, 1) : periods).map((period, i) => ({
                ...period,
                color: chartColor(i),
                markers: false,
                smooth: false,
            })),
        },
    };
}

// Takes the stored string, like the fill and points codecs, so the size limit is measured on what peers store.
export function parseChartSpec(value: string): ChartSpec | null {
    if (new TextEncoder().encode(value).length > MAX_CHART_SPEC_BYTES) return null;
    // One catch for malformed JSON and every field reader's invalid(), so the readers stay straight-line.
    try {
        return chartSpec(JSON.parse(value));
    } catch {
        return null;
    }
}

const INVALID = new Error('invalid chart spec');

function invalid(): never {
    throw INVALID;
}

function chartSpec(v: unknown): ChartSpec {
    const spec = record(v);
    const categoryAxis = record(prop(spec, 'categoryAxis'));
    const valueAxis = record(prop(spec, 'valueAxis'));
    const min = finiteOrNull(prop(valueAxis, 'min'));
    const max = finiteOrNull(prop(valueAxis, 'max'));
    const ordered = min === null || max === null || min < max;
    const format = prop(valueAxis, 'format');
    return {
        type: member(prop(spec, 'type'), CHART_TYPES),
        stacked: flag(prop(spec, 'stacked')),
        title: text(prop(spec, 'title')),
        legend: member(prop(spec, 'legend'), LEGEND_POSITIONS),
        blanks: member(prop(spec, 'blanks'), CHART_BLANKS),
        categoryAxis: { title: text(prop(categoryAxis, 'title')) },
        valueAxis: {
            title: text(prop(valueAxis, 'title')),
            min: ordered ? min : null,
            max: ordered ? max : null,
            gridlines: flag(prop(valueAxis, 'gridlines')),
            format: format === null ? null : text(format),
        },
        sliceColors: list(prop(spec, 'sliceColors')).map(color),
        data: chartData(prop(spec, 'data')),
    };
}

function chartData(v: unknown): InlineChartData | RangeChartData {
    const data = record(v);
    const source = prop(data, 'source');
    const series = list(prop(data, 'series'));
    if (series.length > MAX_CHART_SERIES) invalid();
    if (source === 'inline') {
        const categories = list(prop(data, 'categories')).map(text);
        const inline = series.map(inlineSeries);
        const points = inline.reduce((sum, { values }) => sum + values.length, 0);
        if (points > MAX_CHART_POINTS || categories.length > MAX_CHART_POINTS) invalid();
        return { source, categories, series: inline };
    }
    if (source === 'range') {
        const categories = prop(data, 'categories');
        return {
            source,
            categories: categories === null ? null : cellRange(categories),
            series: series.map(rangeSeries),
        };
    }
    return invalid();
}

function inlineSeries(v: unknown): InlineChartSeries {
    const series = record(v);
    return {
        ...seriesStyle(series),
        name: text(prop(series, 'name')),
        values: list(prop(series, 'values')).map(finiteOrNull),
    };
}

function rangeSeries(v: unknown): RangeChartSeries {
    const series = record(v);
    const name = prop(series, 'name');
    const values = prop(series, 'values');
    return {
        ...seriesStyle(series),
        name: typeof name === 'string' ? text(name) : cellRange(name),
        values: values === null ? null : cellRange(values),
    };
}

function seriesStyle(series: object): ChartSeriesStyle {
    return {
        color: color(prop(series, 'color')),
        markers: flag(prop(series, 'markers')),
        smooth: flag(prop(series, 'smooth')),
    };
}

function cellRange(v: unknown): CellRangeRef {
    const ref = record(v);
    const sheetId = prop(ref, 'sheetId');
    if (typeof sheetId !== 'string' || sheetId === '') invalid();
    return { sheetId, row: span(prop(ref, 'row')), column: span(prop(ref, 'column')) };
}

function span(v: unknown): [number, number] {
    const bounds = list(v);
    const start = cellIndex(bounds[0]);
    const end = cellIndex(bounds[1]);
    return bounds.length === 2 && start <= end ? [start, end] : invalid();
}

function cellIndex(v: unknown): number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : invalid();
}

// Truncated, not rejected: an imported file's overlong label should not cost the whole chart. Every
// label reaches SVG <text>, so what XML cannot hold is dropped here too.
function text(v: unknown): string {
    return typeof v === 'string'
        ? Array.from(stripNonXmlChars(v)).slice(0, MAX_CHART_LABEL_LENGTH).join('')
        : invalid();
}

function color(v: unknown): string {
    return isColorToken(v) ? v : invalid();
}

function flag(v: unknown): boolean {
    return typeof v === 'boolean' ? v : invalid();
}

function finiteOrNull(v: unknown): number | null {
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : invalid();
}

function member<T extends string>(v: unknown, allowed: readonly T[]): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return invalid();
}

function record(v: unknown): object {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : invalid();
}

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : invalid();
}
