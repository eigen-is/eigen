// The plot of a column, bar or line chart: a value axis and a category axis at right angles, their tick and category
// labels, the gridlines and baseline, the marks, which are bars or lines with markers, and the marks' data labels.
// Column and line put the value axis upright left of the plot; bar turns both. The layout calls it with the frame the
// title and legend leave, and with a second context in which the marks draw, flat when the chart is past its sketch cap.

import type { ChartLabel, ChartSeriesStyle, ChartShape, ChartSpec, InlineChartSeries } from '../types/chart';
import { isStackingChartType } from '../types/chart';
import { serializeFill } from '../vector/fill';
import type { Point } from '../vector/geometry';
import type { VectorLinearElement } from '../vector/types';
import type { Context, Frame } from './context';
import { LABEL_SHARE } from './context';
import { fit, hideCrowded, keepUntouched, label, labelBox, measure } from './labels';
import { numberDisplay } from './number-display';
import type { Band, ChartTickFormat, ValueAxis } from './scales';
import { bandScale, MAX_TICK_COUNT, shares, valueAxis, valueExtent } from './scales';
import { ellipse, isOutlined, line, outlineOf, rectangle } from './shapes';
import { formatPercentTick, formatTickValue } from './ticks';

// Excalidraw's faint range; Google's gridlines are a light gray.
export const GRIDLINE_OPACITY = 20;
// Ems between value ticks: vertical axes stack one-line labels, horizontal ones sit numbers side by side.
const VERTICAL_TICK_SPACING = 4;
const HORIZONTAL_TICK_SPACING = 6;
const ROTATED = -45;
const SIN45 = Math.SQRT1_2;
// Float error can put a label that ends at its room's edge a hair past it.
const EDGE_SLACK = 1e-6;

// labeled says whether the series draws its data labels. Its style decides, and no series draws them past the sketch cap.
export type PaintedSeries = InlineChartSeries & { color: string; style: ChartSeriesStyle; labeled: boolean };

// A data label's text and width, measured once before the plot is laid out.
type ValueText = { value: number; text: string; width: number };

// A data label placed by its mark, with its box and the area of its bar or segment, which ranks it in a crowd.
type ValueLabel = { label: ChartLabel; box: Frame; area: number };

// The axis left of the plot takes its title turned -90°, and the one below takes it upright. A hidden axis gives its
// labels' room to the plot. Its title and the gridlines stay. The baseline is the category axis's line, so a hidden
// category axis draws none. A 100% stack plots shares and labels its ticks as percents, whatever the source cells'
// format. Its min and max are shares too, as Excel's c:min and c:max are, where 1 is 100%. A data label reads the raw
// value, in the format ChartLayoutInput describes. Null when the frame is too small for a plot.
export function layoutCartesian(
    ctx: Context,
    marks: Context,
    spec: ChartSpec,
    categories: string[],
    series: PaintedSeries[],
    raw: (number | null)[][],
    frame: Frame,
    sourceFormat: string | undefined,
): ChartShape[] | null {
    const { lineHeight: lh, gap, fontSize } = ctx;
    const { type, blanks } = spec.chart;
    const { x, y } = spec.axes;
    const horizontal = type === 'bar';
    const { stacking } = spec.plots[type];
    const stacked = stacking !== 'none' && isStackingChartType(type);
    const percent = stacked && stacking === 'percent';
    const values = percent ? shares(raw) : raw;
    const format = y.labels.format ?? sourceFormat;
    const formatTick: ChartTickFormat = percent
        ? formatPercentTick
        : format === undefined
          ? formatTickValue
          : (value) => numberDisplay(value, format);
    const valueText = (value: number) => numberDisplay(value, (percent ? sourceFormat : format) ?? 'General');
    const texts = series.map((s, si) =>
        raw[si].map((value): ValueText | null => {
            if (!s.labeled || value === null) return null;
            const text = valueText(value);
            return { value, text, width: measure(ctx, text) };
        }),
    );
    // Labels past a bar's end or above a point need room beyond the marks; a stacked segment's sit inside it.
    const outside = stacked ? [] : texts.flat().filter((text) => text !== null);
    const negative = (text: ValueText) => type !== 'line' && text.value < 0;
    const over = outside.some((text) => !negative(text)) ? lh + gap : 0;
    const under = outside.some(negative) ? lh + gap : 0;
    const widest = (negatives: boolean) =>
        Math.max(0, ...outside.filter((text) => negative(text) === negatives).map((text) => text.width + gap));
    const [low, high] = valueExtent(values, stacked, blanks === 'zero', type !== 'line');
    // Float sums can run a hair past ±100%, which nice ends would round up a whole step.
    const extent: [number, number] = percent ? [Math.max(-1, low), Math.min(1, high)] : [low, high];
    const [sideTitle, bottomTitle] = horizontal ? [x.title.text, y.title.text] : [y.title.text, x.title.text];
    const sideReserve = sideTitle === '' ? 0 : lh + gap;
    const bottomReserve = bottomTitle === '' ? 0 : lh + gap;
    const count = categories.length;
    const showNames = x.visible;
    const showTicks = y.visible;
    const reversed = x.scale.reversed;
    // A bar chart's names sit centered on their bands, so thin bands keep half a line in from the plot's ends.
    const edge = horizontal && showNames ? lh / 2 : 0;

    let plot: Frame;
    // The plot grown by the room its data labels reserve, which a label may not leave.
    let bounds: Frame;
    let axis: ValueAxis;
    let categoryLabels: ChartLabel[];
    if (horizontal) {
        const top = frame.top;
        const bottom = showTicks ? frame.bottom - bottomReserve - gap - lh : frame.bottom - bottomReserve;
        const band = bandScale(count, top, bottom, reversed, edge);
        const every = Math.max(1, Math.ceil(lh / band.step));
        const room = (frame.right - frame.left - sideReserve) * LABEL_SHARE;
        const fitted = showNames ? categories.map((name, i) => (i % every === 0 ? fit(ctx, name, room) : '')) : [];
        const names = showNames
            ? frame.left + sideReserve + Math.max(0, ...fitted.map((name) => measure(ctx, name))) + gap
            : frame.left + sideReserve;
        const [leftRoom, rightRoom] = [widest(true), widest(false)];
        const left = names + leftRoom;
        // Each try asks for as many ticks as the last try's widest pair of labels has room for, until the labels
        // stop touching. The end labels overhang the plot by half a label. Two is the fewest asked, and d3 can
        // answer two with four, so the labels that still touch are hidden below.
        let n = Math.min(
            MAX_TICK_COUNT,
            Math.max(2, Math.floor((frame.right - left) / (fontSize * HORIZONTAL_TICK_SPACING))),
        );
        for (;;) {
            axis = valueAxis(ctx, spec, extent, n, formatTick);
            const { lo, hi, widths } = axis;
            if (!showTicks) {
                plot = { left, top, right: frame.right - rightRoom, bottom };
                break;
            }
            plot = {
                left: Math.max(left, frame.left + widths[0] / 2),
                top,
                right: frame.right - Math.max(widths[widths.length - 1] / 2, rightRoom),
                bottom,
            };
            const perUnit = (plot.right - plot.left) / (hi - lo);
            const needs = widths.map((width, i) => (i === 0 ? 0 : (width + widths[i - 1]) / 2 + gap));
            if (n <= 2 || axis.ticks.every((t, i) => i === 0 || (t - axis.ticks[i - 1]) * perUnit >= needs[i])) break;
            n = Math.max(2, Math.min(n - 1, Math.floor((plot.right - plot.left) / Math.max(...needs))));
        }
        bounds = { ...plot, left: plot.left - leftRoom, right: plot.right + rightRoom };
        categoryLabels = fitted.flatMap((name, i) =>
            name === '' ? [] : [label(ctx, name, plot.left - leftRoom - gap, band.center(i) - lh / 2, 'end')],
        );
    } else {
        // The end tick labels overhang the plot by half a line, below it only where no names sit. Data labels above
        // the marks take that half line into their own line, and a negative column's labels sit above the names.
        const top = frame.top + Math.max(showTicks ? lh / 2 : 0, over);
        const below = showNames ? under : Math.max(showTicks ? lh / 2 : 0, under);
        const floor = frame.bottom - bottomReserve;
        const estimate = (showNames ? floor - gap - lh : floor) - below - top;
        const n = Math.min(MAX_TICK_COUNT, Math.max(2, Math.floor(estimate / (fontSize * VERTICAL_TICK_SPACING))));
        axis = valueAxis(ctx, spec, extent, n, formatTick);
        const left = showTicks ? frame.left + sideReserve + Math.max(...axis.widths) + gap : frame.left + sideReserve;
        const placed = showNames
            ? placeCategoryLabels(ctx, categories, bandScale(count, left, frame.right, reversed), frame, bottomReserve)
            : { labels: [], height: 0 };
        plot = { left, top, right: frame.right, bottom: floor - placed.height - below };
        bounds = { ...plot, top: plot.top - over, bottom: plot.bottom + under };
        categoryLabels = placed.labels.map((placedLabel) => ({
            ...placedLabel,
            y: placedLabel.y + plot.bottom + below + gap,
        }));
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

    const tickLabels: ChartLabel[] = [];
    for (const [i, t] of axis.ticks.entries()) {
        const at = scale(t);
        if (showTicks) {
            tickLabels.push(
                horizontal
                    ? label(ctx, axis.texts[i], at, plot.bottom + gap, 'middle')
                    : label(ctx, axis.texts[i], plot.left - gap, at - lh / 2, 'end'),
            );
        }
        // The baseline draws zero's line; without it a gridline does, as Office keeps its 0 line. Every tick keeps
        // its gridline, its label hidden or not.
        if (y.gridlines.visible && (t !== zero || !showNames)) shapes.push(rule(`gridline:${i}`, at, GRIDLINE_OPACITY));
    }
    ctx.labels.push(...hideCrowded(ctx, tickLabels, Math.max(0, axis.ticks.indexOf(zero))));
    const valueLabels: ValueLabel[] = [];
    if (type === 'line') shapes.push(...lineMarks(marks, spec, series, values, band, scale, texts, valueLabels));
    else shapes.push(...barMarks(marks, spec, series, values, band, scale, horizontal, stacked, texts, valueLabels));
    if (showNames) shapes.push(rule('baseline', scale(zero)));
    // Crowded data labels hide, never move, as Highcharts' do: the biggest bar's label keeps its place, and on a line
    // the first series'. The tick labels and category names sit outside the bounds, so a label inside can't touch them.
    const fits = ({ box }: ValueLabel) =>
        box.left >= bounds.left - EDGE_SLACK &&
        box.right <= bounds.right + EDGE_SLACK &&
        box.top >= bounds.top - EDGE_SLACK &&
        box.bottom <= bounds.bottom + EDGE_SLACK;
    const ranked = valueLabels.filter(fits).sort((a, b) => b.area - a.area);
    ctx.labels.push(...keepUntouched(ctx, ranked));

    const side = fit(ctx, sideTitle, plot.bottom - plot.top);
    if (side !== '')
        ctx.labels.push(label(ctx, side, frame.left, (plot.top + plot.bottom) / 2, 'middle', { rotate: -90 }));
    const below = fit(ctx, bottomTitle, plot.right - plot.left);
    if (below !== '') ctx.labels.push(label(ctx, below, (plot.left + plot.right) / 2, frame.bottom - lh, 'middle'));
    return shapes;
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
    const { lineHeight: lh, gap } = ctx;
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
    for (const [i, name] of names.entries()) {
        if (i % every !== 0) continue;
        // Turned about its top end, so it reaches down-left from just right of the band center.
        const x = band.center(i) - (lh * SIN45) / 2;
        const room = Math.min(maxDrop / SIN45 - lh, (x - frame.left) / SIN45);
        const text = fit(ctx, name, room);
        if (text === '') continue;
        labels.push(label(ctx, text, x, 0, 'end', { rotate: ROTATED }));
        drop = Math.max(drop, (measure(ctx, text) + lh) * SIN45);
    }
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
    texts: (ValueText | null)[][],
    valueLabels: ValueLabel[],
): ChartShape[] {
    const { lineHeight: lh, gap } = ctx;
    const shapes: ChartShape[] = [];
    const ups: number[] = [];
    const downs: number[] = [];
    const slot = stacked ? band.width : band.width / series.length;
    // An outline straddles its bar's edges, so a bar narrows by its outline to keep its slot. Bars side by side then
    // meet outline to outline. A slot thinner than two outlines thins the outline. A solid bar has none.
    const stroke = isOutlined(ctx) ? Math.min(ctx.paint.strokeWidth, slot / 2) : 0;
    for (const [si, s] of series.entries()) {
        const fill = serializeFill({ type: 'solid', color: s.color, style: ctx.paint.fillStyle });
        for (const [c, raw] of values[si].entries()) {
            const value = raw ?? (spec.chart.blanks === 'zero' ? 0 : null);
            if (value === null) continue;
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
            shapes.push({
                ...rectangle(ctx, `bar:${si}:${c}`, box, outlineOf(ctx, s.color), fill),
                strokeWidth: stroke,
            });
            // A data label sits past the bar's end, on the far side of the axis for a negative bar. A stacked segment
            // centers its label inside, and shows none when the label doesn't fit.
            const text = texts[si][c];
            if (!text || (stacked && (text.width > box.width || lh > box.height))) continue;
            const area = box.width * box.height;
            const middle = { x: box.x + box.width / 2, y: box.y + (box.height - lh) / 2 };
            const negative = text.value < 0;
            if (stacked) {
                valueLabels.push(valueLabel(ctx, text, middle.x, middle.y, 'middle', area));
            } else if (horizontal) {
                const x = negative ? box.x - gap : box.x + box.width + gap;
                valueLabels.push(valueLabel(ctx, text, x, middle.y, negative ? 'end' : 'start', area));
            } else {
                const y = negative ? box.y + box.height + gap : box.y - gap - lh;
                valueLabels.push(valueLabel(ctx, text, middle.x, y, 'middle', area));
            }
        }
    }
    return shapes;
}

function valueLabel(
    ctx: Context,
    { text, width }: ValueText,
    x: number,
    y: number,
    anchor: ChartLabel['anchor'],
    area: number,
): ValueLabel {
    const placed = label(ctx, text, x, y, anchor);
    return { label: placed, box: labelBox(ctx, placed, width), area };
}

// One open line per run of plotted points ('gap' breaks a run at a null, 'span' skips the null, 'zero'
// plots 0), then the markers above every line. A point's data label sits above it.
function lineMarks(
    ctx: Context,
    spec: ChartSpec,
    series: PaintedSeries[],
    values: (number | null)[][],
    band: Band,
    scale: (v: number) => number,
    texts: (ValueText | null)[][],
    valueLabels: ValueLabel[],
): ChartShape[] {
    const lines: ChartShape[] = [];
    const markers: ChartShape[] = [];
    const diameter = Math.max(8, ctx.fontSize * 0.6);
    const radius = diameter / 2;
    for (const [si, s] of series.entries()) {
        const markerFill = serializeFill({ type: 'solid', color: s.color, style: 'solid' });
        const runs: { first: number; points: Point[] }[] = [];
        let open = false;
        for (const [c, raw] of values[si].entries()) {
            const value = raw ?? (spec.chart.blanks === 'zero' ? 0 : null);
            if (value === null) {
                if (spec.chart.blanks === 'gap') open = false;
                continue;
            }
            const point = { x: band.center(c), y: scale(value) };
            if (open) runs[runs.length - 1].points.push(point);
            else runs.push({ first: c, points: [point] });
            open = true;
            const text = texts[si][c];
            const above = point.y - ctx.gap - ctx.lineHeight;
            if (text) valueLabels.push(valueLabel(ctx, text, point.x, above, 'middle', 0));
            if (s.style.marker.visible) {
                const box = { x: point.x - radius, y: point.y - radius, width: diameter, height: diameter };
                markers.push(ellipse(ctx, `marker:${si}:${c}`, box, s.color, markerFill));
            }
        }
        for (const run of runs) {
            if (run.points.length < 2) continue;
            const roundness = s.style.line.smooth ? 'round' : 'sharp';
            const drawn = line(ctx, `line:${si}:${run.first}`, run.points, s.color, roundness);
            lines.push({ ...drawn, strokeWidth: ctx.paint.seriesStrokeWidth });
        }
    }
    return [...lines, ...markers];
}
