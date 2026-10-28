// Turns a stored spec, as any peer or paste wrote it, into the validated ChartSpec that search, exports, the layout
// and the editors read. Only the chart's type and its data are required: malformed data or a hard limit resolves as
// null, never a throw, and a presentation field that is missing or invalid reads its default. Keys this build doesn't
// know are left out of the result. The stored-chart reader calls it once per read.

import { isRecord } from '../core/guards';
import { stripNonXmlChars } from '../core/xml';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../sheets/defaults';
import type {
    CellRangeRef,
    ChartAxis,
    ChartPoint,
    ChartSeriesStyle,
    ChartSpec,
    ChartType,
    InlineChartData,
    InlineChartSeries,
    RangeChartData,
    RangeChartSeries,
    StoredChartSpec,
} from '../types/chart';
import { CHART_AXIS_KINDS, CHART_BLANKS, CHART_STACKINGS, CHART_TYPES, LEGEND_POSITIONS } from '../types/chart';
import { bool, color, fontFamily, oneOf, str } from '../vector/kinds/read-fields';
import { prop } from '../vector/types';
import { DEFAULT_CHART_SERIES_STYLE, defaultChartSpec } from './defaults';
import {
    chartPointIndex,
    isChartSeriesId,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
    MAX_CHART_SERIES,
    own,
} from './limits';

// The field readers throw on what makes the spec unreadable, so they stay straight-line, and this one catch turns
// that into null.
export function resolveChartSpec(stored: StoredChartSpec): ChartSpec | null {
    try {
        return validChartSpec(stored);
    } catch {
        return null;
    }
}

// Edit data rebuilds the data from the keys this build reads, so a key it doesn't (a newer build's array beside a
// series' values) would fall out of step with them: such a chart's data is shown, not edited.
export function holdsUnknownChartData(stored: StoredChartSpec, spec: ChartSpec): boolean {
    const known = (item: unknown, read: object) =>
        isRecord(item) && Object.keys(item).every((key) => Object.hasOwn(read, key));
    const data = isRecord(stored['data']) ? stored['data'] : {};
    const series = Array.isArray(data['series']) ? data['series'] : [];
    return !known(data, spec.data) || series.some((item, i) => !known(item, spec.data.series[i]));
}

// What a search finds a chart by: its titles, series names and inline categories, a line each.
export function chartSearchText(spec: ChartSpec | null): string {
    if (!spec) return '';
    const { data } = spec;
    return [
        spec.title.text,
        spec.axes.x.title.text,
        spec.axes.y.title.text,
        ...data.series.flatMap((series) => (typeof series.name === 'string' ? [series.name] : [])),
        ...(data.source === 'inline' ? data.categories : []),
    ]
        .filter((text) => text !== '')
        .join('\n');
}

// Every chart label, stored or read from a cell, reaches SVG <text>, so what XML cannot hold is
// dropped. Truncated, not rejected: an imported file's overlong label should not cost the whole chart.
export function chartLabel(value: string): string {
    return Array.from(stripNonXmlChars(value)).slice(0, MAX_CHART_LABEL_LENGTH).join('');
}

// Whether a value has the shape of a CellRangeRef, so a writer can find a ref under any key. It checks the sheet id and
// the two integer pairs only: extra keys are accepted and the bounds are not checked.
export function isCellRangeShape(value: unknown): value is CellRangeRef {
    const bounds = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger);
    return isRecord(value) && typeof value['sheetId'] === 'string' && bounds(value['row']) && bounds(value['column']);
}

// A part that isn't a record reads as empty, so each of its keys reads its default.
function validChartSpec(v: unknown): ChartSpec {
    const spec = record(v);
    const chart = record(prop(spec, 'chart'));
    const type = member(prop(chart, 'type'), CHART_TYPES);
    const data = chartData(prop(spec, 'data'));
    const defaults = defaultChartSpec(type, data);
    const axes = optionalRecord(prop(spec, 'axes'));
    const plots = optionalRecord(prop(spec, 'plots'));
    const series = optionalRecord(prop(spec, 'series'));
    const plot = (plotType: ChartType) => ({
        stacking: oneOf(
            prop(optionalRecord(own(plots, plotType)), 'stacking'),
            CHART_STACKINGS,
            defaults.plots[plotType].stacking,
        ),
    });
    return {
        chart: {
            type,
            blanks: oneOf(prop(chart, 'blanks'), CHART_BLANKS, defaults.chart.blanks),
            fontFamily: fontFamily(prop(chart, 'fontFamily'), defaults.chart.fontFamily),
        },
        title: { text: labelText(str(prop(optionalRecord(prop(spec, 'title')), 'text'), defaults.title.text)) },
        legend: {
            position: oneOf(
                prop(optionalRecord(prop(spec, 'legend')), 'position'),
                LEGEND_POSITIONS,
                defaults.legend.position,
            ),
        },
        axes: { x: chartAxis(own(axes, 'x'), defaults.axes.x), y: chartAxis(own(axes, 'y'), defaults.axes.y) },
        plots: { column: plot('column'), bar: plot('bar'), line: plot('line'), pie: plot('pie') },
        series: Object.fromEntries(data.series.map(({ id }) => [id, seriesStyle(own(series, id))])),
        points: chartPoints(prop(spec, 'points'), data.series),
        data,
    };
}

// An unknown kind reads its id's, so a later kind on x (a scatter's value axis) still draws as categories.
function chartAxis(v: unknown, defaults: ChartAxis): ChartAxis {
    const axis = optionalRecord(v);
    const scale = optionalRecord(prop(axis, 'scale'));
    const min = finiteOr(prop(scale, 'min'), defaults.scale.min);
    const max = finiteOr(prop(scale, 'max'), defaults.scale.max);
    const ordered = min === null || max === null || min < max;
    const format = prop(optionalRecord(prop(axis, 'labels')), 'format');
    return {
        kind: oneOf(prop(axis, 'kind'), CHART_AXIS_KINDS, defaults.kind),
        title: { text: labelText(str(prop(optionalRecord(prop(axis, 'title')), 'text'), defaults.title.text)) },
        visible: bool(prop(axis, 'visible'), defaults.visible),
        gridlines: {
            visible: bool(prop(optionalRecord(prop(axis, 'gridlines')), 'visible'), defaults.gridlines.visible),
        },
        labels: { format: typeof format === 'string' ? labelText(format) : defaults.labels.format },
        scale: {
            min: ordered ? min : null,
            max: ordered ? max : null,
            reversed: bool(prop(scale, 'reversed'), defaults.scale.reversed),
        },
    };
}

// An unknown plot type draws in the chart's. This build draws one value axis, so every series draws on y.
function seriesStyle(v: unknown): ChartSeriesStyle {
    const style = optionalRecord(v);
    const plot = prop(style, 'plot');
    const defaults = DEFAULT_CHART_SERIES_STYLE;
    return {
        plot: CHART_TYPES.find((type) => type === plot) ?? defaults.plot,
        yAxis: defaults.yAxis,
        color: color(prop(style, 'color'), defaults.color),
        line: { smooth: bool(prop(optionalRecord(prop(style, 'line')), 'smooth'), defaults.line.smooth) },
        marker: { visible: bool(prop(optionalRecord(prop(style, 'marker')), 'visible'), defaults.marker.visible) },
        labels: { visible: bool(prop(optionalRecord(prop(style, 'labels')), 'visible'), defaults.labels.visible) },
    };
}

// The points of the series data names, by a key that is an index; a series with none has no entry.
function chartPoints(v: unknown, series: readonly { id: string }[]): ChartSpec['points'] {
    const stored = optionalRecord(v);
    const points: ChartSpec['points'] = {};
    for (const { id } of series) {
        const entries = optionalRecord(own(stored, id));
        const read = Object.entries(entries).flatMap(([key, entry]): [number, ChartPoint][] => {
            const index = chartPointIndex(key);
            return index !== null && isRecord(entry) ? [[index, { color: color(prop(entry, 'color'), null) }]] : [];
        });
        if (read.length > 0) points[id] = Object.fromEntries(read);
    }
    return points;
}

function chartData(v: unknown): InlineChartData | RangeChartData {
    const data = record(v);
    const source = prop(data, 'source');
    const series = list(prop(data, 'series'));
    if (series.length > MAX_CHART_SERIES) invalid();
    if (source === 'inline') {
        const categories = list(prop(data, 'categories')).map(labelText);
        const inline = uniqueIds(series.map(inlineSeries));
        const points = inline.reduce((sum, { values }) => sum + values.length, 0);
        if (points > MAX_CHART_POINTS || categories.length > MAX_CHART_POINTS) invalid();
        return { source, categories, series: inline };
    }
    if (source === 'range') {
        const categories = prop(data, 'categories');
        return {
            source,
            categories: categories === null ? null : cellRange(categories),
            series: uniqueIds(series.map(rangeSeries)),
        };
    }
    return invalid();
}

function inlineSeries(v: unknown): InlineChartSeries {
    const series = record(v);
    return {
        id: seriesId(prop(series, 'id')),
        name: labelText(str(prop(series, 'name'), '')),
        values: list(prop(series, 'values')).map(finiteOrNull),
    };
}

function rangeSeries(v: unknown): RangeChartSeries {
    const series = record(v);
    const name = prop(series, 'name');
    const values = prop(series, 'values');
    return {
        id: seriesId(prop(series, 'id')),
        name: typeof name === 'string' ? labelText(name) : cellRange(name),
        values: values === null ? null : cellRange(values),
    };
}

function seriesId(v: unknown): string {
    return typeof v === 'string' && isChartSeriesId(v) ? v : invalid();
}

function uniqueIds<S extends { id: string }>(series: S[]): S[] {
    return new Set(series.map(({ id }) => id)).size === series.length ? series : invalid();
}

function cellRange(v: unknown): CellRangeRef {
    const ref = record(v);
    const sheetId = prop(ref, 'sheetId');
    if (typeof sheetId !== 'string' || sheetId === '') invalid();
    return {
        sheetId,
        row: span(prop(ref, 'row'), REFERENCE_ROW_COUNT),
        column: span(prop(ref, 'column'), REFERENCE_COLUMN_COUNT),
    };
}

function span(v: unknown, count: number): [number, number] {
    const bounds = list(v);
    const start = cellIndex(bounds[0], count);
    const end = cellIndex(bounds[1], count);
    return bounds.length === 2 && start <= end ? [start, end] : invalid();
}

function cellIndex(v: unknown, count: number): number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : invalid();
}

function labelText(v: unknown): string {
    return typeof v === 'string' ? chartLabel(v) : invalid();
}

function finiteOrNull(v: unknown): number | null {
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : invalid();
}

function finiteOr(v: unknown, fallback: number | null): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function member<T extends string>(v: unknown, allowed: readonly T[]): T {
    for (const option of allowed) {
        if (option === v) return option;
    }
    return invalid();
}

function record(v: unknown): object {
    return isRecord(v) ? v : invalid();
}

function optionalRecord(v: unknown): Record<string, unknown> {
    return isRecord(v) ? v : {};
}

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : invalid();
}

const INVALID = new Error('invalid chart spec');

function invalid(): never {
    throw INVALID;
}
