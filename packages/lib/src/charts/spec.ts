// The stored-chart codec. A chart is one JSON string wherever it lives (a canvas element field, a docs
// node attribute, a SheetChart), and parseChartSpec is the one reader every surface and importer runs.
// Malformed structure or a hard limit reads as null, never a throw; a presentation field reads its default.

import { EIGEN_ACCENT_COLORS_SHUFFLED } from '../constants/colors';
import { DOCUMENT_FONT } from '../constants/fonts';
import { isRecord } from '../core/guards';
import { stripNonXmlChars } from '../core/xml';
import { MAX_PAPER_MM, mmToPx } from '../docs/eigendoc/page';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '../sheets/defaults';
import {
    type CellRangeRef,
    CHART_BLANKS,
    CHART_STACKINGS,
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
import { bool, color, fontFamily, oneOf, str } from '../vector/kinds/read-fields';
import { prop } from '../vector/types';

// Hard limits: every peer lays out and paints whatever is stored, so they bound one chart's cost.
// Range data counts its points when the sheet resolves it, since a selection can outgrow the limit.
export const MAX_CHART_SPEC_BYTES = 64 * 1024;
export const MAX_CHART_SERIES = 32;
export const MAX_CHART_POINTS = 2000;
export const MAX_CHART_LABEL_LENGTH = 200;
// No chart is drawn wider or taller than the largest page, Word's 22 inches (2112 px): a side past it runs the layout
// for seconds in every viewer and the export, and at a trillion px overflows the painter's stack.
export const CHART_MAX_SIDE = Math.round(mmToPx(MAX_PAPER_MM));

// What the Edit data grid edits; an imported chart over these opens its data read-only. A full grid,
// 12 × 200, is past MAX_CHART_POINTS, so the grid's cells count too.
export const INLINE_GRID_MAX_SERIES = 12;
export const INLINE_GRID_MAX_CATEGORIES = 200;

// Google's chart font, and the one a spec that names none or a font Eigen doesn't bundle reads as.
export const DEFAULT_CHART_FONT = DOCUMENT_FONT;

// The accent colors in the order calendars hand them out, so the first few series and every neighbor stay apart, for a
// color-blind reader too.
// A series or slice whose color is null draws in the one at its index.
export function chartColor(index: number): string {
    return EIGEN_ACCENT_COLORS_SHUFFLED[index % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
}

export function fitsInlineGrid(series: number, rows: number): boolean {
    return series <= INLINE_GRID_MAX_SERIES && rows <= INLINE_GRID_MAX_CATEGORIES && series * rows <= MAX_CHART_POINTS;
}

// The grid pads every series to the longest, so a ragged chart counts as its full grid.
export function exceedsInlineGridLimits(data: InlineChartData): boolean {
    const rows = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return !fitsInlineGrid(data.series.length, rows);
}

// What a new chart starts from and what a missing or invalid presentation field reads as, so a field
// added later reads its default from charts stored before it.
export function defaultChartPresentation(type: ChartType): Omit<ChartSpec, 'type' | 'data'> {
    return {
        stacking: 'none',
        title: '',
        legend: type === 'pie' ? 'none' : 'top',
        blanks: 'gap',
        categoryAxis: { title: '', visible: true, reversed: false },
        valueAxis: { title: '', min: null, max: null, gridlines: true, format: null, visible: true },
        sliceColors: [],
        fontFamily: DEFAULT_CHART_FONT,
    };
}

// A new series, made in Eigen: its color automatic, so the palette colors it by position.
export const DEFAULT_CHART_SERIES_STYLE: ChartSeriesStyle = { color: null, markers: false, smooth: false };

// Insert → Chart's sample, one dataset for every type since the Type switch keeps the data: the share of a source's
// light per 100 nm bin from 300 to 1000 nm, Planck's law at 5772 K (Sun), 2700 K (bulb) and 10000 K (hot star), each
// source summing to 100, so the bars compare and the peak moves with temperature. A pie draws the Sun.
export function sampleChartSpec(type: ChartType): ChartSpec {
    const categories = ['300–400', '400–500', '500–600', '600–700', '700–800', '800–900', '900–1000'];
    const sources = [
        { name: 'Sun', values: [13.1, 18.3, 18.6, 16.5, 13.7, 11.0, 8.8] },
        { name: 'Bulb (incandescent)', values: [0.3, 2.5, 7.5, 14.3, 20.9, 25.8, 28.7] },
        { name: 'Hot star', values: [32.4, 23.8, 16.2, 11.0, 7.5, 5.3, 3.8] },
    ];
    const defaults = defaultChartPresentation(type);
    return {
        ...defaults,
        type,
        title: "Where a star's light goes",
        categoryAxis: { ...defaults.categoryAxis, title: 'Wavelength (nm)' },
        valueAxis: { ...defaults.valueAxis, title: 'Share of light, 300–1000 nm (%)' },
        data: {
            source: 'inline',
            categories,
            series: (type === 'pie' ? sources.slice(0, 1) : sources).map((source) => ({
                ...source,
                ...DEFAULT_CHART_SERIES_STYLE,
            })),
        },
    };
}

export function exceedsChartSpecBytes(value: string): boolean {
    return new TextEncoder().encode(value).length > MAX_CHART_SPEC_BYTES;
}

// What a search finds a chart by: its titles, series names and inline categories, a line each.
export function chartSearchText(spec: ChartSpec | null): string {
    if (!spec) return '';
    const { data } = spec;
    return [
        spec.title,
        spec.categoryAxis.title,
        spec.valueAxis.title,
        ...data.series.flatMap((series) => (typeof series.name === 'string' ? [series.name] : [])),
        ...(data.source === 'inline' ? data.categories : []),
    ]
        .filter((text) => text !== '')
        .join('\n');
}

// Takes the stored string, like the fill and points codecs, so the size limit is measured on what peers store.
export function parseChartSpec(value: string): ChartSpec | null {
    if (exceedsChartSpecBytes(value)) return null;
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
    const type = member(prop(spec, 'type'), CHART_TYPES);
    const defaults = defaultChartPresentation(type);
    const categoryAxis = optionalRecord(prop(spec, 'categoryAxis'));
    const valueAxis = optionalRecord(prop(spec, 'valueAxis'));
    const min = finiteOr(prop(valueAxis, 'min'), defaults.valueAxis.min);
    const max = finiteOr(prop(valueAxis, 'max'), defaults.valueAxis.max);
    const ordered = min === null || max === null || min < max;
    const format = prop(valueAxis, 'format');
    const sliceColors = prop(spec, 'sliceColors');
    const slices = Array.isArray(sliceColors) ? sliceColors : defaults.sliceColors;
    if (slices.length > MAX_CHART_POINTS) invalid();
    return {
        type,
        stacking: oneOf(prop(spec, 'stacking'), CHART_STACKINGS, defaults.stacking),
        title: text(str(prop(spec, 'title'), defaults.title)),
        legend: oneOf(prop(spec, 'legend'), LEGEND_POSITIONS, defaults.legend),
        blanks: oneOf(prop(spec, 'blanks'), CHART_BLANKS, defaults.blanks),
        categoryAxis: {
            title: text(str(prop(categoryAxis, 'title'), defaults.categoryAxis.title)),
            visible: bool(prop(categoryAxis, 'visible'), defaults.categoryAxis.visible),
            reversed: bool(prop(categoryAxis, 'reversed'), defaults.categoryAxis.reversed),
        },
        valueAxis: {
            title: text(str(prop(valueAxis, 'title'), defaults.valueAxis.title)),
            min: ordered ? min : null,
            max: ordered ? max : null,
            gridlines: bool(prop(valueAxis, 'gridlines'), defaults.valueAxis.gridlines),
            format: typeof format === 'string' ? text(format) : defaults.valueAxis.format,
            visible: bool(prop(valueAxis, 'visible'), defaults.valueAxis.visible),
        },
        sliceColors: slices.map((v) => color(v, null)),
        fontFamily: fontFamily(prop(spec, 'fontFamily'), defaults.fontFamily),
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
        name: text(str(prop(series, 'name'), '')),
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
        color: color(prop(series, 'color'), null),
        markers: bool(prop(series, 'markers'), DEFAULT_CHART_SERIES_STYLE.markers),
        smooth: bool(prop(series, 'smooth'), DEFAULT_CHART_SERIES_STYLE.smooth),
    };
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

// Every chart label, stored or read from a cell, reaches SVG <text>, so what XML cannot hold is
// dropped. Truncated, not rejected: an imported file's overlong label should not cost the whole chart.
export function chartLabel(value: string): string {
    return Array.from(stripNonXmlChars(value)).slice(0, MAX_CHART_LABEL_LENGTH).join('');
}

function text(v: unknown): string {
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

function optionalRecord(v: unknown): object {
    return isRecord(v) ? v : {};
}

function list(v: unknown): unknown[] {
    return Array.isArray(v) ? v : invalid();
}
