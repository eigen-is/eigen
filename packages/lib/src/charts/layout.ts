// A chart as canvas elements plus text: the one layout every surface draws and Convert to shapes unpacks.
// Pure and synchronous, in the box's local coordinates; Google's chart look (text scales with the box,
// legend on top, light gridlines, no tick marks, zero-based bars).

import type {
    ChartBox,
    ChartLabel,
    ChartLayout,
    ChartLayoutInput,
    ChartPaint,
    ChartShape,
    ChartSpec,
    InlineChartSeries,
} from '../types/chart';
import { isTransparentFill, parseFill, serializeFill, TRANSPARENT_COLOR, TRANSPARENT_FILL } from '../vector/fill';
import { getLineHeightPx } from '../vector/font-metrics';
import { type Box, DEG_TO_RAD, type Point, pointsBounds, serializePoints } from '../vector/geometry';
import { normalizeAngle } from '../vector/outline';
import { measureLabel } from '../vector/text-width';
import type {
    VectorElementBase,
    VectorEllipseElement,
    VectorLinearElement,
    VectorPieElement,
    VectorRectangleElement,
} from '../vector/types';
import { chartColor } from './spec';
import { formatPercentTick, nice, tickStep, ticks } from './ticks';

// Every line a chart draws in place of a plot.
export const CHART_MESSAGES = {
    noData: 'No data',
    pieNeedsPositive: 'Pie charts need positive values',
    tooSmall: 'Chart too small',
    unreadable: "This chart can't be shown",
    ref: '#REF!',
    tooManyPoints: 'Too much data for a chart',
};

// The one paint of a chart in a document or a sheet, which store none: Google's flat look on the page's
// own background, in the spec's font. strokeColor draws the baseline at full strength and the gridlines faint
// (GRIDLINE_OPACITY), so a mid gray gives a clear baseline and Google's light gridlines. strokeWidth is
// every shape's line; 2 is Google's series line width, so a line series reads at page scale, and it
// lengthens a bar by only 1px an end.
export const FLAT_CHART_PAINT: ChartPaint = {
    color: '#202124',
    background: serializeFill(TRANSPARENT_FILL),
    strokeColor: '#757575',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    seed: 1,
    fillStyle: 'solid',
};

// Base text size as a share of the box's shorter side, as Google's charts scale theirs.
const TEXT_SCALE = 0.035;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 64;
const TITLE_SCALE = 1.3;
// Observable Plot's band padding, inner and outer.
const BAND_PADDING = 0.1;
// Ems between value ticks: vertical axes stack one-line labels, horizontal ones sit numbers side by side.
const VERTICAL_TICK_SPACING = 4;
const HORIZONTAL_TICK_SPACING = 6;
// The most value ticks asked of d3 however long the axis: Google's axes stop at about 20 labels, and the
// box comes from a peer, so its length must not set the work.
const MAX_TICK_COUNT = 20;
// Excalidraw's faint range; Google's gridlines are a light gray.
const GRIDLINE_OPACITY = 20;
// Share of the room a label column, a legend or turned category labels may take before they ellipsize or drop.
const LABEL_SHARE = 0.3;
const ROTATED = -45;
const SIN45 = Math.SQRT1_2;
// No leader lines, so a thin slice goes unlabeled rather than colliding.
const MIN_LABELED_SLICE = 0.05;
const PIE_EDGE_WIDTH = 1;
// Keeps sums and spans finite whatever a cell holds; nothing plots past it anyway.
const MAX_VALUE = 1e100;
// d3 ticks a step under one by its inverse, which overflows near the smallest double, so a span under
// this lays out as a zero span.
const MIN_SPAN = 1e-300;
const ELLIPSIS = '…';

type Frame = { left: number; top: number; right: number; bottom: number };
type Anchor = ChartLabel['anchor'];

// The per-chart constants every step reads.
type Context = {
    id: string;
    paint: ChartPaint;
    fontFamily: string;
    width: number;
    height: number;
    fontSize: number;
    lineHeight: number;
    pad: number;
    gap: number;
    labels: ChartLabel[];
};

type LegendItem = { name: string; color: string };
type PaintedSeries = InlineChartSeries & { color: string };

export function layoutChart({ spec, data, formatTick, ...box }: ChartLayoutInput): ChartLayout {
    const ctx = context(box, spec.fontFamily);
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
    const series = data.series.map((s, i) => ({ ...s, color: s.color ?? chartColor(i) }));

    if (spec.type === 'pie') {
        const slices = values[0];
        if (slices.some((value) => value !== null && value < 0)) return message(CHART_MESSAGES.pieNeedsPositive);
        if (!slices.some((value) => value !== null && value > 0)) return message(CHART_MESSAGES.noData);
    }

    let frame = placeTitle(ctx, spec.title);
    const items: LegendItem[] =
        spec.type === 'pie'
            ? categories.map((name, i) => ({ name, color: sliceColor(spec, i) }))
            : series.map(({ name, color }) => ({ name, color }));
    const legend = placeLegend(ctx, spec.legend, items, frame);
    frame = legend.frame;

    const plot =
        spec.type === 'pie'
            ? layoutPie(ctx, spec, categories, values[0], frame)
            : layoutCartesian(ctx, spec, categories, series, values, frame, formatTick);
    if (!plot) return message(CHART_MESSAGES.tooSmall);
    return { shapes: [...background, ...plot, ...legend.shapes], labels: ctx.labels };
}

// The chart's background and one centered line instead of a plot, as a chart with nothing to plot draws.
export function layoutChartMessage(box: ChartBox, text: string, fontFamily: string): ChartLayout {
    const ctx = context(box, fontFamily);
    return { shapes: backgroundShapes(ctx), labels: messageLabel(ctx, text) };
}

function context({ id, width: w, height: h, paint }: ChartBox, fontFamily: string): Context {
    const width = Math.max(0, w);
    const height = Math.max(0, h);
    const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, TEXT_SCALE * Math.min(width, height)));
    return {
        id,
        paint,
        fontFamily,
        width,
        height,
        fontSize,
        lineHeight: getLineHeightPx(fontFamily, fontSize),
        pad: fontSize,
        gap: fontSize / 2,
        labels: [],
    };
}

// Solid whatever the fill's hatch style: that style is the marks', and a hatched backdrop behind hatched
// bars reads as noise.
function backgroundShapes(ctx: Context): ChartShape[] {
    const fill = parseFill(ctx.paint.background);
    if (isTransparentFill(fill)) return [];
    const box = { x: 0, y: 0, width: ctx.width, height: ctx.height };
    return [rectangle(ctx, 'background', box, TRANSPARENT_COLOR, serializeFill({ ...fill, style: 'solid' }))];
}

function sliceColor(spec: ChartSpec, index: number): string {
    return spec.sliceColors[index] ?? chartColor(index);
}

function messageLabel(ctx: Context, text: string): ChartLabel[] {
    if (ctx.lineHeight > ctx.height) return [];
    const fitted = fit(ctx, text, ctx.width - 2 * ctx.pad, ctx.fontSize, false);
    return fitted === '' ? [] : [label(ctx, fitted, ctx.width / 2, (ctx.height - ctx.lineHeight) / 2, 'middle')];
}

function placeTitle(ctx: Context, title: string): Frame {
    const frame = { left: ctx.pad, top: ctx.pad, right: ctx.width - ctx.pad, bottom: ctx.height - ctx.pad };
    const size = ctx.fontSize * TITLE_SCALE;
    const text = fit(ctx, title, frame.right - frame.left, size, true);
    if (text === '') return frame;
    ctx.labels.push(label(ctx, text, ctx.width / 2, frame.top, 'middle', { fontSize: size, bold: true }));
    return { ...frame, top: frame.top + getLineHeightPx(ctx.fontFamily, size) + ctx.gap };
}

// A swatch and its name per item: top and bottom wrap centered rows, left and right a column centered on
// the room left. Items past the room are dropped rather than squeezing the plot away, and a "+N" after
// the last one kept counts them.
function placeLegend(
    ctx: Context,
    position: ChartSpec['legend'],
    items: LegendItem[],
    frame: Frame,
): { shapes: ChartShape[]; frame: Frame } {
    const { lineHeight: lh, gap } = ctx;
    const swatch = ctx.fontSize * 0.8;
    const indent = swatch + ctx.fontSize * 0.4;
    const spacing = ctx.fontSize;
    const shapes: ChartShape[] = [];
    const place = (item: LegendItem, index: number, text: string, x: number, top: number) => {
        const y = top + (lh - swatch) / 2;
        const fill = serializeFill({ type: 'solid', color: item.color, style: ctx.paint.fillStyle });
        shapes.push(rectangle(ctx, `legend:${index}`, { x, y, width: swatch, height: swatch }, item.color, fill));
        ctx.labels.push(label(ctx, text, x + indent, top, 'start'));
    };
    if (position === 'none' || items.length === 0) return { shapes, frame };

    if (position === 'top' || position === 'bottom') {
        const room = frame.right - frame.left;
        const fitted = items.map((item) => fit(ctx, item.name, room - indent, ctx.fontSize, false));
        const rows: number[][] = [[]];
        let rowWidth = 0;
        fitted.forEach((text, i) => {
            const itemWidth = indent + measure(ctx, text);
            const row = rows[rows.length - 1];
            if (row.length > 0 && rowWidth + spacing + itemWidth > room) {
                rows.push([i]);
                rowWidth = itemWidth;
            } else {
                row.push(i);
                rowWidth += (row.length > 1 ? spacing : 0) + itemWidth;
            }
        });
        const maxRows = Math.max(1, Math.floor(((frame.bottom - frame.top) * LABEL_SHARE) / lh));
        const kept = rows.slice(0, maxRows);
        const widthsOf = (row: number[], tail: string) => [
            ...row.map((i) => indent + measure(ctx, fitted[i])),
            ...(tail === '' ? [] : [measure(ctx, tail)]),
        ];
        const lineWidth = (widths: number[]) =>
            widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, widths.length - 1);
        const last = kept[kept.length - 1];
        const shown = () => kept.reduce((sum, row) => sum + row.length, 0);
        let more = kept.length < rows.length ? `+${items.length - shown()}` : '';
        while (more !== '' && last.length > 0 && lineWidth(widthsOf(last, more)) > room) {
            last.pop();
            more = `+${items.length - shown()}`;
        }
        const top = position === 'top' ? frame.top : frame.bottom - kept.length * lh;
        kept.forEach((row, r) => {
            const tail = row === last ? more : '';
            const widths = widthsOf(row, tail);
            let x = (frame.left + frame.right) / 2 - lineWidth(widths) / 2;
            row.forEach((i, k) => {
                place(items[i], i, fitted[i], x, top + r * lh);
                x += widths[k] + spacing;
            });
            if (tail !== '') ctx.labels.push(label(ctx, tail, x, top + r * lh, 'start'));
        });
        const used = kept.length * lh + gap;
        return {
            shapes,
            frame: position === 'top' ? { ...frame, top: frame.top + used } : { ...frame, bottom: frame.bottom - used },
        };
    }

    const room = (frame.right - frame.left) * LABEL_SHARE - indent;
    const fitted = items.map((item) => fit(ctx, item.name, room, ctx.fontSize, false));
    const fits = Math.max(0, Math.floor((frame.bottom - frame.top) / lh));
    const kept = items.length > fits ? items.slice(0, fits - 1) : items;
    const more = kept.length < items.length && fits > 0 ? `+${items.length - kept.length}` : '';
    const columnWidth = indent + Math.max(measure(ctx, more), ...fitted.map((text) => measure(ctx, text)));
    const top = (frame.top + frame.bottom - (kept.length + (more === '' ? 0 : 1)) * lh) / 2;
    const x = position === 'left' ? frame.left : frame.right - columnWidth;
    kept.forEach((item, i) => {
        place(item, i, fitted[i], x, top + i * lh);
    });
    if (more !== '') ctx.labels.push(label(ctx, more, x + indent, top + kept.length * lh, 'start'));
    const used = columnWidth + 2 * gap;
    return {
        shapes,
        frame: position === 'left' ? { ...frame, left: frame.left + used } : { ...frame, right: frame.right - used },
    };
}

type ValueAxis = { lo: number; hi: number; ticks: number[]; texts: string[]; widths: number[] };

// Column and line chart a vertical value axis left of a horizontal band axis; bar turns both. The axis
// left of the plot takes its title turned -90°, the one below takes it upright. A hidden axis gives its labels'
// room to the plot and draws no line, the baseline being the category axis's; its title and the gridlines stay.
// A 100% stack plots shares and labels its ticks as percents, whatever the source cells' format; its min
// and max are shares too, Excel's c:min and c:max (1 is 100%).
function layoutCartesian(
    ctx: Context,
    spec: ChartSpec,
    categories: string[],
    series: PaintedSeries[],
    stored: (number | null)[][],
    frame: Frame,
    sourceFormat: ChartLayoutInput['formatTick'],
): ChartShape[] | null {
    const { lineHeight: lh, gap, fontSize } = ctx;
    const horizontal = spec.type === 'bar';
    const stacked = spec.stacking !== 'none' && spec.type !== 'line';
    const percent = stacked && spec.stacking === 'percent';
    const values = percent ? shares(stored) : stored;
    const formatTick = percent ? formatPercentTick : sourceFormat;
    const [low, high] = valueExtent(values, stacked, spec.blanks === 'zero', spec.type !== 'line');
    // Float sums can run a hair past ±100%, which nice ends would round up a whole step.
    const extent: [number, number] = percent ? [Math.max(-1, low), Math.min(1, high)] : [low, high];
    const [sideTitle, bottomTitle] = horizontal
        ? [spec.categoryAxis.title, spec.valueAxis.title]
        : [spec.valueAxis.title, spec.categoryAxis.title];
    const sideReserve = sideTitle === '' ? 0 : lh + gap;
    const bottomReserve = bottomTitle === '' ? 0 : lh + gap;
    const count = categories.length;
    const showNames = spec.categoryAxis.visible;
    const showTicks = spec.valueAxis.visible;
    const reversed = spec.categoryAxis.reversed;
    // A bar chart's names sit centered on their bands, so thin bands keep half a line in from the plot's ends.
    const edge = horizontal && showNames ? lh / 2 : 0;

    let plot: Frame;
    let axis: ValueAxis;
    let categoryLabels: ChartLabel[];
    if (horizontal) {
        const top = frame.top;
        const bottom = showTicks ? frame.bottom - bottomReserve - gap - lh : frame.bottom - bottomReserve;
        const band = bandScale(count, top, bottom, reversed, edge);
        const every = Math.max(1, Math.ceil(lh / band.step));
        const room = (frame.right - frame.left - sideReserve) * LABEL_SHARE;
        const fitted = showNames
            ? categories.map((name, i) => (i % every === 0 ? fit(ctx, name, room, fontSize, false) : ''))
            : [];
        const left = showNames
            ? frame.left + sideReserve + Math.max(0, ...fitted.map((name) => measure(ctx, name))) + gap
            : frame.left + sideReserve;
        // Fewer ticks until their labels stop touching, each try as many as the last one's widest pair has
        // room for; the end labels overhang the plot by half a label.
        let n = Math.min(
            MAX_TICK_COUNT,
            Math.max(2, Math.floor((frame.right - left) / (fontSize * HORIZONTAL_TICK_SPACING))),
        );
        for (;;) {
            axis = valueAxis(spec, extent, n, formatTick, ctx);
            const { lo, hi, widths } = axis;
            if (!showTicks) {
                plot = { left, top, right: frame.right, bottom };
                break;
            }
            plot = {
                left: Math.max(left, frame.left + widths[0] / 2),
                top,
                right: frame.right - widths[widths.length - 1] / 2,
                bottom,
            };
            const perUnit = (plot.right - plot.left) / (hi - lo);
            const needs = widths.map((width, i) => (i === 0 ? 0 : (width + widths[i - 1]) / 2 + gap));
            if (n <= 2 || axis.ticks.every((t, i) => i === 0 || (t - axis.ticks[i - 1]) * perUnit >= needs[i])) break;
            n = Math.max(2, Math.min(n - 1, Math.floor((plot.right - plot.left) / Math.max(...needs))));
        }
        categoryLabels = fitted.flatMap((name, i) =>
            name === '' ? [] : [label(ctx, name, plot.left - gap, band.center(i) - lh / 2, 'end')],
        );
    } else {
        // The end tick labels overhang the plot by half a line, below it only where no names sit.
        const top = frame.top + (showTicks ? lh / 2 : 0);
        const floor = frame.bottom - bottomReserve - (showTicks && !showNames ? lh / 2 : 0);
        const estimate = (showNames ? floor - gap - lh : floor) - top;
        axis = valueAxis(
            spec,
            extent,
            Math.min(MAX_TICK_COUNT, Math.max(2, Math.floor(estimate / (fontSize * VERTICAL_TICK_SPACING)))),
            formatTick,
            ctx,
        );
        const left = showTicks ? frame.left + sideReserve + Math.max(...axis.widths) + gap : frame.left + sideReserve;
        const placed = showNames
            ? placeCategoryLabels(ctx, categories, bandScale(count, left, frame.right, reversed), frame, bottomReserve)
            : { labels: [], height: 0 };
        plot = { left, top, right: frame.right, bottom: floor - placed.height };
        categoryLabels = placed.labels.map((placedLabel) => ({ ...placedLabel, y: placedLabel.y + plot.bottom + gap }));
    }
    const minPlot = 2 * fontSize;
    if (plot.right - plot.left < minPlot || plot.bottom - plot.top < minPlot) return null;
    ctx.labels.push(...categoryLabels);

    const { lo, hi } = axis;
    // Value → pixel along the value axis, held to the plot so min/max clip the marks.
    const scale = (v: number): number => {
        const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        return horizontal ? plot.left + t * (plot.right - plot.left) : plot.bottom - t * (plot.bottom - plot.top);
    };
    // A gridline or the baseline: across the plot at a value-axis pixel.
    const rule = (key: string, at: number, opacity = 100): VectorLinearElement & { type: 'line' } => {
        const ends = horizontal
            ? [
                  { x: at, y: plot.top },
                  { x: at, y: plot.bottom },
              ]
            : [
                  { x: plot.left, y: at },
                  { x: plot.right, y: at },
              ];
        return { ...line(ctx, key, ends, ctx.paint.strokeColor, 'sharp', opacity), strokeStyle: ctx.paint.strokeStyle };
    };
    const band = horizontal
        ? bandScale(count, plot.top, plot.bottom, reversed, edge)
        : bandScale(count, plot.left, plot.right, reversed);
    const zero = Math.min(hi, Math.max(lo, 0));
    const shapes: ChartShape[] = [];

    axis.ticks.forEach((t, i) => {
        const at = scale(t);
        if (showTicks) {
            ctx.labels.push(
                horizontal
                    ? label(ctx, axis.texts[i], at, plot.bottom + gap, 'middle')
                    : label(ctx, axis.texts[i], plot.left - gap, at - lh / 2, 'end'),
            );
        }
        // The baseline draws zero's line; without it a gridline does, as Office keeps its 0 line.
        if (spec.valueAxis.gridlines && (t !== zero || !showNames))
            shapes.push(rule(`gridline:${i}`, at, GRIDLINE_OPACITY));
    });
    if (spec.type === 'line') shapes.push(...lineMarks(ctx, spec, series, values, band, scale));
    else shapes.push(...barMarks(ctx, spec, series, values, band, scale, horizontal, stacked));
    if (showNames) shapes.push(rule('baseline', scale(zero)));

    const side = fit(ctx, sideTitle, plot.bottom - plot.top, fontSize, false);
    if (side !== '')
        ctx.labels.push(label(ctx, side, frame.left, (plot.top + plot.bottom) / 2, 'middle', { rotate: -90 }));
    const below = fit(ctx, bottomTitle, plot.right - plot.left, fontSize, false);
    if (below !== '') ctx.labels.push(label(ctx, below, (plot.left + plot.right) / 2, frame.bottom - lh, 'middle'));
    return shapes;
}

// The data's range, zero included for bars, which grow from it; a line's axis fits its data, as Excel's
// and Google's do, unless the line is flat. Stacks sum positives and negatives apart.
function valueExtent(
    values: (number | null)[][],
    stacked: boolean,
    zeroBlanks: boolean,
    zeroBased: boolean,
): [number, number] {
    let lo = zeroBased ? 0 : Number.POSITIVE_INFINITY;
    let hi = zeroBased ? 0 : Number.NEGATIVE_INFINITY;
    const categories = values[0].length;
    for (let c = 0; c < categories; c++) {
        let up = 0;
        let down = 0;
        for (const row of values) {
            const value = row[c] ?? (zeroBlanks ? 0 : null);
            if (value === null) continue;
            if (stacked) {
                if (value >= 0) up += value;
                else down += value;
            } else {
                hi = Math.max(hi, value);
                lo = Math.min(lo, value);
            }
        }
        if (stacked) {
            hi = Math.max(hi, up);
            lo = Math.min(lo, down);
        }
    }
    if (!(hi - lo >= MIN_SPAN)) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
    }
    return hi - lo >= MIN_SPAN ? [lo, hi] : [0, 1];
}

// Each value as its share of its category's absolute sum (Excel's percentStacked, Plot's normalize), so
// positives and negatives together span 100%. A category summing to zero has no shares and draws no bar.
function shares(values: (number | null)[][]): (number | null)[][] {
    const totals = values[0].map((_, c) => values.reduce((sum, row) => sum + Math.abs(row[c] ?? 0), 0));
    return values.map((row) => row.map((value, c) => (value === null || totals[c] === 0 ? null : value / totals[c])));
}

// Nice ends unless min or max pins one; ticks from d3 over the final domain. d3 takes the count as a
// hint and can hand back half as many again, so a count that overshoots MAX_TICK_COUNT asks again for
// fewer, which steps up to the next nice step.
function valueAxis(
    spec: ChartSpec,
    [low, high]: [number, number],
    count: number,
    formatTick: ChartLayoutInput['formatTick'],
    ctx: Context,
): ValueAxis {
    const { min, max } = spec.valueAxis;
    for (let n = count; ; n--) {
        let [lo, hi] = nice(low, high, n);
        if (min !== null) lo = min;
        if (max !== null) hi = max;
        if (lo >= hi) {
            const span = high - low;
            if (min !== null) hi = lo + span;
            else lo = hi - span;
        }
        // Pins too close to tick, or past a double's precision at their size, give way to the data's domain.
        if (!(hi - lo >= MIN_SPAN)) [lo, hi] = nice(low, high, n);
        const values = ticks(lo, hi, n);
        if (values.length > MAX_TICK_COUNT && n > 1) continue;
        const step = tickStep(lo, hi, n);
        const texts = values.map((value) => formatTick(value, step));
        return { lo, hi, ticks: values, texts, widths: texts.map((text) => measure(ctx, text)) };
    }
}

type Band = {
    step: number;
    width: number;
    reversed: boolean;
    start: (i: number) => number;
    center: (i: number) => number;
};

// Bands from `from` to `to`, the first at `from` unless reversed. The end bands' centers keep at least `edge` in
// from the ends, the range inset where thin bands would put them closer.
function bandScale(count: number, from: number, to: number, reversed = false, edge = 0): Band {
    const span = Math.max(1, count - BAND_PADDING + 2 * BAND_PADDING);
    // The first band's center, in steps from the range's start.
    const first = (1 + BAND_PADDING) / 2;
    const length = to - from;
    const inset =
        span > 2 * first && (first * length) / span < edge ? (edge * span - first * length) / (span - 2 * first) : 0;
    const step = (length - 2 * inset) / span;
    const width = step * (1 - BAND_PADDING);
    const start = (i: number) => from + inset + step * BAND_PADDING + (reversed ? count - 1 - i : i) * step;
    return { step, width, reversed, start, center: (i) => start(i) + width / 2 };
}

// Upright and centered under their bands while they fit; else turned -45° and ellipsized to the room
// below the plot and left of their band, every nth when even turned ones would touch. Returned with y
// relative to the label row's top, and the row's height.
function placeCategoryLabels(
    ctx: Context,
    names: string[],
    band: Band,
    frame: Frame,
    reserved: number,
): { labels: ChartLabel[]; height: number } {
    const { lineHeight: lh, gap, fontSize } = ctx;
    if (names.every((name) => measure(ctx, name) <= band.step - gap / 2)) {
        return {
            labels: names.flatMap((name, i) => (name === '' ? [] : [label(ctx, name, band.center(i), 0, 'middle')])),
            height: gap + lh,
        };
    }
    const every = Math.max(1, Math.ceil(lh / (band.step * SIN45)));
    const maxDrop = (frame.bottom - frame.top - reserved) * LABEL_SHARE;
    const labels: ChartLabel[] = [];
    let drop = 0;
    names.forEach((name, i) => {
        if (i % every !== 0) return;
        // Turned about its top end, so it reaches down-left from just right of the band center.
        const x = band.center(i) - (lh * SIN45) / 2;
        const room = Math.min(maxDrop / SIN45 - lh, (x - frame.left) / SIN45);
        const text = fit(ctx, name, room, fontSize, false);
        if (text === '') return;
        labels.push(label(ctx, text, x, 0, 'end', { rotate: ROTATED }));
        drop = Math.max(drop, (measure(ctx, text) + lh) * SIN45);
    });
    return { labels, height: gap + drop };
}

function barMarks(
    ctx: Context,
    spec: ChartSpec,
    series: PaintedSeries[],
    values: (number | null)[][],
    band: Band,
    scale: (v: number) => number,
    horizontal: boolean,
    stacked: boolean,
): ChartShape[] {
    const shapes: ChartShape[] = [];
    const ups: number[] = [];
    const downs: number[] = [];
    const slot = stacked ? band.width : band.width / series.length;
    // An outline straddles its bar's edges, so a bar narrows by its outline to keep its slot, and side by
    // side bars meet outline to outline; a slot thinner than two outlines thins the outline.
    const stroke = Math.min(ctx.paint.strokeWidth, slot / 2);
    series.forEach((s, si) => {
        const fill = serializeFill({ type: 'solid', color: s.color, style: ctx.paint.fillStyle });
        values[si].forEach((stored, c) => {
            const value = stored ?? (spec.blanks === 'zero' ? 0 : null);
            if (value === null) return;
            let from = 0;
            if (stacked) {
                from = value >= 0 ? (ups[c] ?? 0) : (downs[c] ?? 0);
                if (value >= 0) ups[c] = from + value;
                else downs[c] = from + value;
            }
            const a = scale(from);
            const b = scale(from + value);
            // A reversed axis turns the band too, so the first series sits where the axis starts.
            const position = band.reversed ? series.length - 1 - si : si;
            const offset = band.start(c) + (stacked ? 0 : position * slot) + stroke / 2;
            const box = horizontal
                ? { x: Math.min(a, b), y: offset, width: Math.abs(b - a), height: slot - stroke }
                : { x: offset, y: Math.min(a, b), width: slot - stroke, height: Math.abs(b - a) };
            shapes.push({ ...rectangle(ctx, `bar:${si}:${c}`, box, s.color, fill), strokeWidth: stroke });
        });
    });
    return shapes;
}

// One open line per run of plotted points ('gap' breaks a run at a null, 'span' skips the null, 'zero'
// plots 0), then the markers above every line.
function lineMarks(
    ctx: Context,
    spec: ChartSpec,
    series: PaintedSeries[],
    values: (number | null)[][],
    band: Band,
    scale: (v: number) => number,
): ChartShape[] {
    const lines: ChartShape[] = [];
    const markers: ChartShape[] = [];
    const diameter = Math.max(8, ctx.fontSize * 0.6);
    series.forEach((s, si) => {
        const markerFill = serializeFill({ type: 'solid', color: s.color, style: 'solid' });
        const runs: { first: number; points: Point[] }[] = [];
        let open = false;
        values[si].forEach((stored, c) => {
            const value = stored ?? (spec.blanks === 'zero' ? 0 : null);
            if (value === null) {
                if (spec.blanks === 'gap') open = false;
                return;
            }
            const point = { x: band.center(c), y: scale(value) };
            if (open) runs[runs.length - 1].points.push(point);
            else runs.push({ first: c, points: [point] });
            open = true;
            if (s.markers) {
                const r = diameter / 2;
                markers.push(
                    ellipse(
                        ctx,
                        `marker:${si}:${c}`,
                        { x: point.x - r, y: point.y - r, width: diameter, height: diameter },
                        s.color,
                        markerFill,
                    ),
                );
            }
        });
        for (const run of runs) {
            if (run.points.length < 2) continue;
            lines.push(line(ctx, `line:${si}:${run.first}`, run.points, s.color, s.smooth ? 'round' : 'sharp'));
        }
    });
    return [...lines, ...markers];
}

// One slice per positive value, clockwise from 12 o'clock, its name and share just outside the arc; the
// radius shrinks until every label fits the frame.
function layoutPie(
    ctx: Context,
    spec: ChartSpec,
    categories: string[],
    values: (number | null)[],
    frame: Frame,
): ChartShape[] | null {
    const { lineHeight: lh, gap, fontSize } = ctx;
    const total = values.reduce<number>((sum, value) => sum + (value !== null && value > 0 ? value : 0), 0);
    const full = Math.min(frame.right - frame.left, frame.bottom - frame.top) / 2;
    if (full < fontSize) return null;
    const cx = (frame.left + frame.right) / 2;
    const cy = (frame.top + frame.bottom) / 2;

    let swept = 0;
    const slices = values.flatMap((value, c) => {
        if (value === null || value <= 0) return [];
        const share = value / total;
        const start = normalizeAngle(270 + swept * 360);
        swept += share;
        return [{ c, share, start, sweep: share * 360 }];
    });

    const labelRoom = (frame.right - frame.left) * LABEL_SHARE;
    const placed = slices
        .filter((slice) => slice.share >= MIN_LABELED_SLICE)
        .map((slice) => {
            const percent = `${Math.round(slice.share * 100)}%`;
            const name = categories[slice.c];
            const text = fit(ctx, name === '' ? percent : `${name} ${percent}`, labelRoom, fontSize, false);
            const mid = (slice.start + slice.sweep / 2) * DEG_TO_RAD;
            const cos = Math.cos(mid);
            const sin = Math.sin(mid);
            const anchor: Anchor = cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle';
            const width = measure(ctx, text);
            const left = anchor === 'start' ? 0 : anchor === 'middle' ? -width / 2 : -width;
            return { text, cos, sin, anchor, left, right: left + width };
        })
        .filter((entry) => entry.text !== '');

    // Each label edge is linear in the radius, so each frame side caps it directly.
    let radius = full;
    for (const entry of placed) {
        const top = -lh / 2 + (lh / 2) * entry.sin;
        radius = Math.min(
            radius,
            cap(-entry.left, -entry.cos, cx - frame.left) - gap,
            cap(entry.right, entry.cos, frame.right - cx) - gap,
            cap(-top, -entry.sin, cy - frame.top) - gap,
            cap(top + lh, entry.sin, frame.bottom - cy) - gap,
        );
    }
    const labeled = radius >= full / 2;
    if (!labeled) radius = full;

    const background = parseFill(ctx.paint.background);
    const shapes = slices.map((slice) => {
        const color = sliceColor(spec, slice.c);
        const edge = background.type === 'solid' && !isTransparentFill(background) ? background.color : color;
        const fill = serializeFill({ type: 'solid', color, style: ctx.paint.fillStyle });
        return pie(
            ctx,
            `slice:0:${slice.c}`,
            { x: cx - radius, y: cy - radius, width: 2 * radius, height: 2 * radius },
            edge,
            fill,
            slice.start,
            slice.sweep,
        );
    });
    if (labeled) {
        for (const entry of placed) {
            const x = cx + (radius + gap) * entry.cos;
            const y = cy + (radius + gap) * entry.sin - lh / 2 + (lh / 2) * entry.sin;
            ctx.labels.push(label(ctx, entry.text, x, y, entry.anchor));
        }
    }
    return shapes;
}

// The largest distance t from the center that keeps a label edge, `offset + t * direction` toward one
// frame side, within that side's `limit`.
function cap(offset: number, direction: number, limit: number): number {
    if (direction > 1e-9) return (limit - offset) / direction;
    return offset <= limit ? Number.POSITIVE_INFINITY : 0;
}

function measure(ctx: Context, text: string, fontSize = ctx.fontSize, bold = false): number {
    return measureLabel(text, ctx.fontFamily, fontSize, bold);
}

// The text as is when it fits, else its longest prefix that fits with an ellipsis, else ''.
function fit(ctx: Context, text: string, maxWidth: number, fontSize: number, bold: boolean): string {
    if (measure(ctx, text, fontSize, bold) <= maxWidth) return text;
    const chars = Array.from(text);
    let width = measure(ctx, ELLIPSIS, fontSize, bold);
    let end = 0;
    while (end < chars.length) {
        width += measure(ctx, chars[end], fontSize, bold);
        if (width > maxWidth) break;
        end++;
    }
    const head = chars.slice(0, end).join('').trimEnd();
    return head === '' ? '' : head + ELLIPSIS;
}

function label(
    ctx: Context,
    text: string,
    x: number,
    y: number,
    anchor: Anchor,
    options: { fontSize?: number; bold?: boolean; rotate?: number } = {},
): ChartLabel {
    return {
        text,
        x,
        y,
        anchor,
        fontFamily: ctx.fontFamily,
        fontSize: options.fontSize ?? ctx.fontSize,
        bold: options.bold ?? false,
        color: ctx.paint.color,
        rotate: options.rotate ?? 0,
    };
}

// Seeds from the paint's seed and the shape's key, so a chart redraws the same jitter and no two of its
// shapes share one; never 0, which roughjs reads as "pick a random one".
function seedOf(seed: number, key: string): number {
    let hash = (seed >>> 0) ^ 0x811c9dc5;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
    return ((hash >>> 0) % (2 ** 31 - 1)) + 1;
}

function base(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
): Omit<VectorElementBase, 'type'> {
    return {
        id: `${ctx.id}:${key}`,
        ...box,
        angle: 0,
        index: '',
        frameId: '',
        commentCardIds: '',
        opacity: 100,
        strokeColor,
        strokeWidth: ctx.paint.strokeWidth,
        strokeStyle: 'solid',
        roughness: ctx.paint.roughness,
        seed: seedOf(ctx.paint.seed, key),
    };
}

function rectangle(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
): VectorRectangleElement {
    return { ...base(ctx, key, box, strokeColor), type: 'rectangle', fill, corners: 'straight' };
}

function ellipse(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
): VectorEllipseElement {
    return { ...base(ctx, key, box, strokeColor), type: 'ellipse', fill };
}

function pie(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
    startAngle: number,
    sweepAngle: number,
): VectorPieElement {
    return {
        ...base(ctx, key, box, strokeColor),
        strokeWidth: PIE_EDGE_WIDTH,
        type: 'pie',
        fill,
        startAngle,
        sweepAngle,
    };
}

// Points relative to the element's min corner.
function line(
    ctx: Context,
    key: string,
    points: Point[],
    strokeColor: string,
    roundness: VectorLinearElement['roundness'],
    opacity = 100,
): VectorLinearElement & { type: 'line' } {
    const { minX, minY, maxX, maxY } = pointsBounds(points);
    return {
        ...base(ctx, key, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, strokeColor),
        opacity,
        type: 'line',
        fill: serializeFill(TRANSPARENT_FILL),
        points: serializePoints(points.map((p) => ({ x: p.x - minX, y: p.y - minY }))),
        roundness,
        pressures: '',
        simulatePressure: true,
    };
}
