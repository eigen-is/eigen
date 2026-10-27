// The two axes of a column, bar or line chart as numbers. The value axis gets its domain from the data, its nice ends
// and its ticks; the category axis gets one band per category. The cartesian layout asks for these and turns them into
// pixels, labels and marks.

import type { ChartSpec } from '../types/chart';
import type { Context } from './context';
import { measure } from './labels';
import { nice, tickStep, ticks } from './ticks';

// The most value ticks asked of d3 however long the axis: Google's axes stop at about 20 labels, and the
// box comes from a peer, so its length must not set the work.
export const MAX_TICK_COUNT = 20;
// The share of its category's band that a category's bars fill, side by side or stacked. It is Google's
// bar.groupWidth, the golden ratio.
export const BAR_GROUP_WIDTH = 0.618;
// d3 ticks a step under one by its inverse, which overflows near the smallest double. So a span under this lays out
// as a zero span.
const MIN_SPAN = 1e-300;
// A line's axis takes in zero when its smallest magnitude is under this share of its largest, so when the spread is
// over a sixth of the largest magnitude. That is Excel's rule, which LibreOffice's ScaleAutomatism mirrors.
const WIDE_SPREAD = 5 / 6;

// A tick's text from its value and the axis's step.
export type ChartTickFormat = (value: number, step: number) => string;

export type ValueAxis = { lo: number; hi: number; ticks: number[]; texts: string[]; widths: number[] };

export type Band = {
    step: number;
    width: number;
    reversed: boolean;
    start: (i: number) => number;
    center: (i: number) => number;
};

// The data's range. Bars grow from zero, so it takes in zero for them. A line's axis takes in zero when the line is
// flat or spreads wide, and otherwise fits its data. Stacks sum positives and negatives apart.
export function valueExtent(
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
    if (lo > 0 && lo / hi < WIDE_SPREAD) lo = 0;
    if (hi < 0 && hi / lo < WIDE_SPREAD) hi = 0;
    if (!(hi - lo >= MIN_SPAN)) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
    }
    return hi - lo >= MIN_SPAN ? [lo, hi] : [0, 1];
}

// Each value as its share of its category's absolute sum (Excel's percentStacked, Plot's normalize), so
// positives and negatives together span 100%. A category summing to zero has no shares and draws no bar.
export function shares(values: (number | null)[][]): (number | null)[][] {
    const totals = values[0].map((_, c) => values.reduce((sum, row) => sum + Math.abs(row[c] ?? 0), 0));
    return values.map((row) => row.map((value, c) => (value === null || totals[c] === 0 ? null : value / totals[c])));
}

// Nice ends unless min or max pins one; ticks from d3 over the final domain. d3 takes the count as a
// hint and can hand back half as many again, so a count that overshoots MAX_TICK_COUNT asks again for
// fewer, which steps up to the next nice step.
export function valueAxis(
    ctx: Context,
    spec: ChartSpec,
    [low, high]: [number, number],
    count: number,
    formatTick: ChartTickFormat,
): ValueAxis {
    const { min, max } = spec.axes.y.scale;
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

// One band per category, tiling `from` to `to` as Office and Google lay out a category axis. The first band is at
// `from` unless the axis is reversed. `width` is the bars' share of a band, centered in it. The end bands' centers
// keep at least `edge` in from the ends, so where thin bands would put them closer the range is inset.
export function bandScale(count: number, from: number, to: number, reversed: boolean, edge = 0): Band {
    const length = to - from;
    const inset = count > 1 && length / count / 2 < edge ? (edge * count - length / 2) / (count - 1) : 0;
    const step = (length - 2 * inset) / count;
    const width = step * BAR_GROUP_WIDTH;
    const center = (i: number) => from + inset + ((reversed ? count - 1 - i : i) + 0.5) * step;
    return { step, width, reversed, start: (i) => center(i) - width / 2, center };
}
