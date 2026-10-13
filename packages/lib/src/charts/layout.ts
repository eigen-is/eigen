// A chart as canvas elements plus text: the one layout every surface draws and Convert to shapes unpacks.
// Pure and synchronous, in the box's local coordinates; Google's chart look (text scales with the box,
// legend on top, light gridlines, no tick marks, zero-based bars).

import type {
    ChartData,
    ChartLabel,
    ChartLayout,
    ChartLayoutInput,
    ChartPaint,
    ChartSpec,
    InlineChartSeries,
} from '../types/chart';
import { isTransparentFill, parseFill, serializeFill, TRANSPARENT_COLOR, TRANSPARENT_FILL } from '../vector/fill';
import { getLineHeightPx } from '../vector/font-metrics';
import { normalizeAngle } from '../vector/outline';
import { measureLabel } from '../vector/text-width';
import type {
    VectorElement,
    VectorElementBase,
    VectorEllipseElement,
    VectorLinearElement,
    VectorPieElement,
    VectorRectangleElement,
} from '../vector/types';
import { chartColor } from './spec';
import { nice, tickStep, ticks } from './ticks';

const MESSAGES = {
    noData: 'No data',
    pieNeedsPositive: 'Pie charts need positive values',
    tooSmall: 'Chart too small',
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
// Excalidraw's faint range; Google's gridlines are a light gray.
const GRIDLINE_OPACITY = 20;
// Share of the room a label column, a legend or turned category labels may take before they ellipsize or drop.
const LABEL_SHARE = 0.3;
const ROTATED = -45;
const SIN45 = Math.SQRT1_2;
// T4-R8: no leader lines, so a thin slice goes unlabeled rather than colliding.
const MIN_LABELED_SLICE = 0.05;
const PIE_EDGE_WIDTH = 1;
// Keeps sums and spans finite whatever a cell holds; nothing plots past it anyway.
const MAX_VALUE = 1e100;
const ELLIPSIS = '…';

type Frame = { left: number; top: number; right: number; bottom: number };
type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Anchor = ChartLabel['anchor'];

// The per-chart constants every step reads.
type Context = {
    id: string;
    paint: ChartPaint;
    width: number;
    height: number;
    fontSize: number;
    lineHeight: number;
    pad: number;
    gap: number;
    labels: ChartLabel[];
};

type LegendItem = { name: string; color: string };

// The box and paint every layout starts from, a message's included.
type ChartBox = Pick<ChartLayoutInput, 'id' | 'width' | 'height' | 'paint'>;

export function layoutChart({ spec, data, formatTick, ...box }: ChartLayoutInput): ChartLayout {
    const ctx = context(box);
    const background = backgroundShapes(ctx);
    const message = (text: string): ChartLayout => ({ shapes: background, labels: messageLabel(ctx, text) });

    const count = data.series.reduce((most, series) => Math.max(most, series.values.length), data.categories.length);
    if (data.series.length === 0 || count === 0) return message(MESSAGES.noData);
    const values = data.series.map((series) =>
        Array.from({ length: count }, (_, i) => clampValue(series.values[i] ?? null)),
    );
    const categories = Array.from({ length: count }, (_, i) => data.categories[i] ?? '');

    if (spec.type === 'pie') {
        const slices = values[0];
        if (slices.some((value) => value !== null && value < 0)) return message(MESSAGES.pieNeedsPositive);
        if (!slices.some((value) => value !== null && value > 0)) return message(MESSAGES.noData);
    }

    let frame = placeTitle(ctx, spec.title);
    const items: LegendItem[] =
        spec.type === 'pie'
            ? categories.map((name, i) => ({ name, color: sliceColor(spec, i) }))
            : data.series.map((series) => ({ name: series.name, color: series.color }));
    const legend = placeLegend(ctx, spec.legend, items, frame);
    frame = legend.frame;

    const plot =
        spec.type === 'pie'
            ? layoutPie(ctx, spec, categories, values[0], frame)
            : layoutCartesian(ctx, spec, { categories, series: data.series }, values, frame, formatTick);
    if (!plot) return message(MESSAGES.tooSmall);
    return { shapes: [...background, ...plot, ...legend.shapes], labels: ctx.labels };
}

// The chart's background and one centered line instead of a plot, as a chart with nothing to plot draws.
export function layoutChartMessage(box: ChartBox, text: string): ChartLayout {
    const ctx = context(box);
    return { shapes: backgroundShapes(ctx), labels: messageLabel(ctx, text) };
}

function context({ id, width: w, height: h, paint }: ChartBox): Context {
    const width = Math.max(0, w);
    const height = Math.max(0, h);
    const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, TEXT_SCALE * Math.min(width, height)));
    return {
        id,
        paint,
        width,
        height,
        fontSize,
        lineHeight: getLineHeightPx(paint.fontFamily, fontSize),
        pad: fontSize,
        gap: fontSize / 2,
        labels: [],
    };
}

function backgroundShapes(ctx: Context): VectorElement[] {
    const fill = parseFill(ctx.paint.background);
    if (isTransparentFill(fill)) return [];
    const box = { x: 0, y: 0, width: ctx.width, height: ctx.height };
    return [rectangle(ctx, 'background', box, TRANSPARENT_COLOR, serializeFill(fill))];
}

function clampValue(value: number | null): number | null {
    return value === null ? null : Math.min(MAX_VALUE, Math.max(-MAX_VALUE, value));
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
    return { ...frame, top: frame.top + getLineHeightPx(ctx.paint.fontFamily, size) + ctx.gap };
}

// A swatch and its name per item: top and bottom wrap centered rows, left and right a column centered on
// the room left. Rows or items past the room are dropped rather than squeezing the plot away.
function placeLegend(
    ctx: Context,
    position: ChartSpec['legend'],
    items: LegendItem[],
    frame: Frame,
): { shapes: VectorElement[]; frame: Frame } {
    const { lineHeight: lh, gap } = ctx;
    const swatch = ctx.fontSize * 0.8;
    const indent = swatch + ctx.fontSize * 0.4;
    const spacing = ctx.fontSize;
    const shapes: VectorElement[] = [];
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
        const top = position === 'top' ? frame.top : frame.bottom - kept.length * lh;
        kept.forEach((row, r) => {
            const widths = row.map((i) => indent + measure(ctx, fitted[i]));
            let x =
                (frame.left + frame.right) / 2 -
                (widths.reduce((sum, width) => sum + width, 0) + spacing * (row.length - 1)) / 2;
            row.forEach((i, k) => {
                place(items[i], i, fitted[i], x, top + r * lh);
                x += widths[k] + spacing;
            });
        });
        const used = kept.length * lh + gap;
        return {
            shapes,
            frame: position === 'top' ? { ...frame, top: frame.top + used } : { ...frame, bottom: frame.bottom - used },
        };
    }

    const room = (frame.right - frame.left) * LABEL_SHARE - indent;
    const fitted = items.map((item) => fit(ctx, item.name, room, ctx.fontSize, false));
    const columnWidth = indent + Math.max(...fitted.map((text) => measure(ctx, text)));
    const fits = Math.max(0, Math.floor((frame.bottom - frame.top) / lh));
    const kept = items.slice(0, fits);
    const top = (frame.top + frame.bottom - kept.length * lh) / 2;
    const x = position === 'left' ? frame.left : frame.right - columnWidth;
    kept.forEach((item, i) => {
        place(item, i, fitted[i], x, top + i * lh);
    });
    const used = columnWidth + 2 * gap;
    return {
        shapes,
        frame: position === 'left' ? { ...frame, left: frame.left + used } : { ...frame, right: frame.right - used },
    };
}

type ValueAxis = { lo: number; hi: number; ticks: number[]; texts: string[]; widths: number[] };

// Column and line chart a vertical value axis left of a horizontal band axis; bar turns both. The axis
// left of the plot takes its title turned -90°, the one below takes it upright.
function layoutCartesian(
    ctx: Context,
    spec: ChartSpec,
    data: ChartData,
    values: (number | null)[][],
    frame: Frame,
    formatTick: ChartLayoutInput['formatTick'],
): VectorElement[] | null {
    const { lineHeight: lh, gap, fontSize } = ctx;
    const horizontal = spec.type === 'bar';
    const stacked = spec.stacked && spec.type !== 'line';
    const extent = valueExtent(values, stacked, spec.blanks === 'zero');
    const [sideTitle, bottomTitle] = horizontal
        ? [spec.categoryAxis.title, spec.valueAxis.title]
        : [spec.valueAxis.title, spec.categoryAxis.title];
    const sideReserve = sideTitle === '' ? 0 : lh + gap;
    const bottomReserve = bottomTitle === '' ? 0 : lh + gap;
    const count = data.categories.length;

    let plot: Frame;
    let axis: ValueAxis;
    let categoryLabels: ChartLabel[];
    if (horizontal) {
        const top = frame.top;
        const bottom = frame.bottom - bottomReserve - gap - lh;
        const band = bandScale(count, top, bottom);
        const every = Math.max(1, Math.ceil(lh / band.step));
        const room = (frame.right - frame.left - sideReserve) * LABEL_SHARE;
        const names = data.categories.map((name, i) => (i % every === 0 ? fit(ctx, name, room, fontSize, false) : ''));
        const left = frame.left + sideReserve + Math.max(0, ...names.map((name) => measure(ctx, name))) + gap;
        // Fewer ticks until their labels stop touching; the end labels overhang the plot by half a label.
        let n = Math.max(2, Math.floor((frame.right - left) / (fontSize * HORIZONTAL_TICK_SPACING))) + 1;
        let clear: boolean;
        do {
            n--;
            axis = valueAxis(spec, extent, n, formatTick, ctx);
            const { lo, hi, widths } = axis;
            plot = {
                left: Math.max(left, frame.left + widths[0] / 2),
                top,
                right: frame.right - widths[widths.length - 1] / 2,
                bottom,
            };
            const perUnit = (plot.right - plot.left) / (hi - lo);
            clear = axis.ticks.every(
                (t, i) => i === 0 || (t - axis.ticks[i - 1]) * perUnit >= (widths[i] + widths[i - 1]) / 2 + gap,
            );
        } while (!clear && n > 2);
        categoryLabels = names.flatMap((name, i) =>
            name === '' ? [] : [label(ctx, name, plot.left - gap, band.center(i) - lh / 2, 'end')],
        );
    } else {
        const top = frame.top + lh / 2;
        const estimate = frame.bottom - bottomReserve - gap - lh - top;
        axis = valueAxis(
            spec,
            extent,
            Math.max(2, Math.floor(estimate / (fontSize * VERTICAL_TICK_SPACING))),
            formatTick,
            ctx,
        );
        const left = frame.left + sideReserve + Math.max(...axis.widths) + gap;
        const placed = placeCategoryLabels(
            ctx,
            data.categories,
            bandScale(count, left, frame.right),
            frame,
            bottomReserve,
        );
        plot = { left, top, right: frame.right, bottom: frame.bottom - bottomReserve - placed.height };
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
    const rule = (key: string, at: number, opacity = 100): VectorLinearElement => {
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
    const band = horizontal ? bandScale(count, plot.top, plot.bottom) : bandScale(count, plot.left, plot.right);
    const zero = Math.min(hi, Math.max(lo, 0));
    const shapes: VectorElement[] = [];

    axis.ticks.forEach((t, i) => {
        const at = scale(t);
        ctx.labels.push(
            horizontal
                ? label(ctx, axis.texts[i], at, plot.bottom + gap, 'middle')
                : label(ctx, axis.texts[i], plot.left - gap, at - lh / 2, 'end'),
        );
        if (spec.valueAxis.gridlines && t !== zero) shapes.push(rule(`gridline:${i}`, at, GRIDLINE_OPACITY));
    });
    if (spec.type === 'line') shapes.push(...lineMarks(ctx, spec, data.series, values, band, scale));
    else shapes.push(...barMarks(ctx, spec, data.series, values, band, scale, horizontal, stacked));
    shapes.push(rule('baseline', scale(zero)));

    const side = fit(ctx, sideTitle, plot.bottom - plot.top, fontSize, false);
    if (side !== '')
        ctx.labels.push(label(ctx, side, frame.left, (plot.top + plot.bottom) / 2, 'middle', { rotate: -90 }));
    const below = fit(ctx, bottomTitle, plot.right - plot.left, fontSize, false);
    if (below !== '') ctx.labels.push(label(ctx, below, (plot.left + plot.right) / 2, frame.bottom - lh, 'middle'));
    return shapes;
}

// The data's range, zero included (bars grow from it; Google's line charts start there too). Stacks
// sum positives and negatives apart.
function valueExtent(values: (number | null)[][], stacked: boolean, zeroBlanks: boolean): [number, number] {
    let lo = 0;
    let hi = 0;
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
        hi = Math.max(hi, up);
        lo = Math.min(lo, down);
    }
    return lo === hi ? [0, 1] : [lo, hi];
}

// Nice ends unless min or max pins one; ticks from d3 over the final domain.
function valueAxis(
    spec: ChartSpec,
    [low, high]: [number, number],
    count: number,
    formatTick: ChartLayoutInput['formatTick'],
    ctx: Context,
): ValueAxis {
    let [lo, hi] = nice(low, high, count);
    const { min, max } = spec.valueAxis;
    if (min !== null) lo = min;
    if (max !== null) hi = max;
    if (lo >= hi) {
        const span = high - low;
        if (min !== null) hi = lo + span;
        else lo = hi - span;
    }
    const values = ticks(lo, hi, count);
    const step = tickStep(lo, hi, count);
    const texts = values.map((value) => formatTick(value, step));
    return { lo, hi, ticks: values, texts, widths: texts.map((text) => measure(ctx, text)) };
}

type Band = { step: number; width: number; start: (i: number) => number; center: (i: number) => number };

function bandScale(count: number, from: number, to: number): Band {
    const step = (to - from) / Math.max(1, count - BAND_PADDING + 2 * BAND_PADDING);
    const width = step * (1 - BAND_PADDING);
    const start = (i: number) => from + step * BAND_PADDING + i * step;
    return { step, width, start, center: (i) => start(i) + width / 2 };
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
    series: InlineChartSeries[],
    values: (number | null)[][],
    band: Band,
    scale: (v: number) => number,
    horizontal: boolean,
    stacked: boolean,
): VectorElement[] {
    const shapes: VectorElement[] = [];
    const ups: number[] = [];
    const downs: number[] = [];
    const slot = stacked ? band.width : band.width / series.length;
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
            const offset = band.start(c) + (stacked ? 0 : si * slot);
            const box = horizontal
                ? { x: Math.min(a, b), y: offset, width: Math.abs(b - a), height: slot }
                : { x: offset, y: Math.min(a, b), width: slot, height: Math.abs(b - a) };
            shapes.push(rectangle(ctx, `bar:${si}:${c}`, box, s.color, fill));
        });
    });
    return shapes;
}

// One open line per run of plotted points ('gap' breaks a run at a null, 'span' skips the null, 'zero'
// plots 0), then the markers above every line.
function lineMarks(
    ctx: Context,
    spec: ChartSpec,
    series: InlineChartSeries[],
    values: (number | null)[][],
    band: Band,
    scale: (v: number) => number,
): VectorElement[] {
    const lines: VectorElement[] = [];
    const markers: VectorElement[] = [];
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
): VectorElement[] | null {
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
            const mid = ((slice.start + slice.sweep / 2) * Math.PI) / 180;
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
    return measureLabel(text, ctx.paint.fontFamily, fontSize, bold);
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
        fontFamily: ctx.paint.fontFamily,
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

function base(ctx: Context, key: string, box: Rect, strokeColor: string): Omit<VectorElementBase, 'type'> {
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

function rectangle(ctx: Context, key: string, box: Rect, strokeColor: string, fill: string): VectorRectangleElement {
    return { ...base(ctx, key, box, strokeColor), type: 'rectangle', fill, corners: 'straight' };
}

function ellipse(ctx: Context, key: string, box: Rect, strokeColor: string, fill: string): VectorEllipseElement {
    return { ...base(ctx, key, box, strokeColor), type: 'ellipse', fill };
}

function pie(
    ctx: Context,
    key: string,
    box: Rect,
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

// Points relative to the element's min corner, at the points codec's two decimals.
function line(
    ctx: Context,
    key: string,
    points: Point[],
    strokeColor: string,
    roundness: VectorLinearElement['roundness'],
    opacity = 100,
): VectorLinearElement {
    const left = Math.min(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y));
    const right = Math.max(...points.map((p) => p.x));
    const bottom = Math.max(...points.map((p) => p.y));
    const relative = points.map((p) => [Math.round((p.x - left) * 100) / 100, Math.round((p.y - top) * 100) / 100]);
    return {
        ...base(ctx, key, { x: left, y: top, width: right - left, height: bottom - top }, strokeColor),
        opacity,
        type: 'line',
        fill: serializeFill(TRANSPARENT_FILL),
        points: JSON.stringify(relative),
        roundness,
        pressures: '',
        simulatePressure: true,
    };
}
