// A chart as canvas elements plus lines of text: the one layout every surface draws and Convert to shapes unpacks.
// Pure and synchronous, in the box's local coordinates, so the server and the live canvas run the same code. It
// places the title and legend, hands the rest of the box to the pie or the cartesian plot, and draws one centered
// message instead when there is nothing to plot. The look is Google's: text scales with the box, light gridlines,
// no tick marks, zero-based bars.

import type {
    ChartBox,
    ChartData,
    ChartLabel,
    ChartLayout,
    ChartLayoutInput,
    ChartShape,
    ChartSpec,
} from '../types/chart';
import { isTransparentFill, parseFill, serializeFill, TRANSPARENT_COLOR } from '../vector/fill';
import { getLineHeightPx } from '../vector/font-metrics';
import { layoutCartesian } from './cartesian';
import type { Context, Frame } from './context';
import { chartContext } from './context';
import { chartColor, chartSeriesStyle } from './defaults';
import { fit, label } from './labels';
import type { LegendItem } from './legend';
import { placeLegend } from './legend';
import { layoutPie, sliceColor } from './pie';
import { rectangle } from './shapes';

// Every line a chart draws in place of a plot.
export const CHART_MESSAGES = {
    noData: 'No data',
    pieNeedsPositive: 'Pie charts need positive values',
    tooSmall: 'Chart too small',
    unreadable: "This chart can't be shown",
    ref: '#REF!',
    tooManyPoints: 'Too much data for a chart',
};

// Past this many points a chart's data marks (bars, slices, lines, markers) draw flat, while its background, gridlines,
// axes and legend keep the sketch. A rough or hatched mark costs ~20x a flat one: at 2000 x 1200, cross-hatched, 200
// points take 35-55 ms and 1.5-3.8 MB of SVG to draw on the server, and 400 points 70-110 ms and 3-7.5 MB, which every
// viewer then parses and paints, and a doc copies as an <img> and prints.
export const MAX_SKETCH_POINTS = 200;

const TITLE_SCALE = 1.3;
// Keeps sums and spans finite whatever a cell holds; nothing plots past it anyway.
const MAX_VALUE = 1e100;

export function layoutChart({ spec, data, formatTick, ...box }: ChartLayoutInput): ChartLayout {
    const ctx = chartContext(box, spec.chart.fontFamily);
    const background = backgroundShapes(ctx);
    const message = (text: string): ChartLayout => ({ shapes: background, labels: messageLabel(ctx, text) });

    const count = data.series.reduce((most, series) => Math.max(most, series.values.length), data.categories.length);
    if (data.series.length === 0 || count === 0) return message(CHART_MESSAGES.noData);
    const values = data.series.map((series) =>
        Array.from({ length: count }, (_, i) => {
            const value = series.values[i] ?? null;
            return value === null ? null : Math.min(MAX_VALUE, Math.max(-MAX_VALUE, value));
        }),
    );
    if (values.every((row) => row.every((value) => value === null))) return message(CHART_MESSAGES.noData);
    const categories = Array.from({ length: count }, (_, i) => data.categories[i] ?? '');
    // An automatic color is the palette's at the series' place in the spec, so a range series after one whose values
    // were deleted keeps the color the editor shows it in.
    const series = data.series.map((s, i) => {
        const style = chartSeriesStyle(spec, s.id);
        const place = spec.data.series.findIndex(({ id }) => id === s.id);
        return { ...s, style, color: style.color ?? chartColor(place === -1 ? i : place) };
    });
    const type = spec.chart.type;
    // A pie draws its first series, whose points are its slices.
    const pieId = data.series[0].id;

    if (type === 'pie') {
        const slices = values[0];
        if (slices.some((value) => value !== null && value < 0)) return message(CHART_MESSAGES.pieNeedsPositive);
        if (!slices.some((value) => value !== null && value > 0)) return message(CHART_MESSAGES.noData);
    }

    const items: LegendItem[] =
        type === 'pie'
            ? categories.map((name, i) => ({ name, color: sliceColor(spec, pieId, i) }))
            : series.map(({ name, color }) => ({ name, color }));
    const legend = placeLegend(ctx, spec.legend.position, items, placeTitle(ctx, spec.title.text));
    const frame = legend.frame;

    // Past MAX_SKETCH_POINTS the data marks draw unsketched and solid, their labels still the chart's.
    const marks: Context = isSketchCapped(spec, data)
        ? { ...ctx, paint: { ...ctx.paint, roughness: 0, fillStyle: 'solid' } }
        : ctx;
    const plot =
        type === 'pie'
            ? layoutPie(marks, spec, pieId, categories, values[0], frame)
            : layoutCartesian(ctx, marks, spec, categories, series, values, frame, formatTick);
    if (!plot) return message(CHART_MESSAGES.tooSmall);
    return { shapes: [...background, ...plot, ...legend.shapes], labels: ctx.labels };
}

// The values the chart plots: a pie's first series, every series' otherwise.
export function chartPointCount(spec: ChartSpec, data: ChartData): number {
    const plotted = spec.chart.type === 'pie' ? data.series.slice(0, 1) : data.series;
    return plotted.reduce((sum, series) => sum + series.values.length, 0);
}

// Whether the chart's data marks draw flat whatever its look, which a panel says.
export function isSketchCapped(spec: ChartSpec, data: ChartData): boolean {
    return chartPointCount(spec, data) > MAX_SKETCH_POINTS;
}

// The same for a chart that holds its data, as a doc's and a canvas's do; a range's lives on its sheet.
export function isInlineSketchCapped(spec: ChartSpec): boolean {
    return spec.data.source === 'inline' && isSketchCapped(spec, spec.data);
}

// The chart's background and one centered line instead of a plot, as a chart with nothing to plot draws.
export function layoutChartMessage(box: ChartBox, text: string, fontFamily: string): ChartLayout {
    const ctx = chartContext(box, fontFamily);
    return { shapes: backgroundShapes(ctx), labels: messageLabel(ctx, text) };
}

// Solid whatever the fill's hatch style: that style is the marks', and a hatched backdrop behind hatched
// bars reads as noise.
function backgroundShapes(ctx: Context): ChartShape[] {
    const fill = parseFill(ctx.paint.background);
    if (isTransparentFill(fill)) return [];
    const box = { x: 0, y: 0, width: ctx.width, height: ctx.height };
    return [rectangle(ctx, 'background', box, TRANSPARENT_COLOR, serializeFill({ ...fill, style: 'solid' }))];
}

function messageLabel(ctx: Context, text: string): ChartLabel[] {
    if (ctx.lineHeight > ctx.height) return [];
    const fitted = fit(ctx, text, ctx.width - 2 * ctx.pad);
    return fitted === '' ? [] : [label(ctx, fitted, ctx.width / 2, (ctx.height - ctx.lineHeight) / 2, 'middle')];
}

// The title on top in bold; returns the frame below it, inside the padding.
function placeTitle(ctx: Context, title: string): Frame {
    const frame = { left: ctx.pad, top: ctx.pad, right: ctx.width - ctx.pad, bottom: ctx.height - ctx.pad };
    const size = ctx.fontSize * TITLE_SCALE;
    const text = fit(ctx, title, frame.right - frame.left, size, true);
    if (text === '') return frame;
    ctx.labels.push(label(ctx, text, ctx.width / 2, frame.top, 'middle', { fontSize: size, bold: true }));
    return { ...frame, top: frame.top + getLineHeightPx(ctx.fontFamily, size) + ctx.gap };
}
